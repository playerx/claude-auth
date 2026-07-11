/**
 * Minimal SDK for Anthropic account authentication (OAuth 2.0 + PKCE),
 * the same process Claude Code CLI uses.
 *
 * Flow:
 *   createAuthorizationRequest()  -> share `url` with the user
 *   exchangeCode()                -> user pastes "code#state" back, get tokens
 *   refreshTokens()               -> mint a new access token from the refresh token
 *   ClaudeAuthClient              -> holds tokens, auto-refreshes, persists to disk
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Public OAuth client ID used by Claude Code CLI
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
// `user:sessions:claude_code` is required to create/drive remote sessions (the
// `rc` command). The others match what Claude Code CLI requests.
export const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code";

export const API_BASE = "https://api.anthropic.com";
export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

/** Refresh this many ms before the access token actually expires. */
const EXPIRY_SKEW_MS = 60_000;

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** Unix epoch ms when the access token expires (0 = unknown). */
  expiresAt: number;
  scope?: string;
}

export interface AuthorizationRequest {
  /** Share this URL with the user; they log in and get a code. */
  url: string;
  /** Keep these two secret; needed for the exchange step. */
  verifier: string;
  state: string;
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toTokens(raw: TokenEndpointResponse, previous?: Tokens): Tokens {
  return {
    accessToken: raw.access_token,
    // Endpoint may not rotate the refresh token — keep the old one if absent
    refreshToken: raw.refresh_token ?? previous?.refreshToken,
    expiresAt: raw.expires_in ? Date.now() + raw.expires_in * 1000 : 0,
    scope: raw.scope ?? previous?.scope,
  };
}

async function postToken(body: Record<string, string>): Promise<TokenEndpointResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Token endpoint returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as TokenEndpointResponse;
}

/** Step 1: build the authorization URL to share with the user. */
export function createAuthorizationRequest(): AuthorizationRequest {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return { url: `${AUTHORIZE_URL}?${params}`, verifier, state };
}

/** Step 2: exchange the pasted "code#state" string for tokens. */
export async function exchangeCode(pasted: string, request: AuthorizationRequest): Promise<Tokens> {
  const [code, returnedState] = pasted.trim().split("#");
  if (!code) throw new Error("Empty authorization code");
  if (returnedState && returnedState !== request.state) {
    throw new Error("State mismatch — possible CSRF, aborting");
  }
  const raw = await postToken({
    grant_type: "authorization_code",
    code,
    state: returnedState ?? request.state,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: request.verifier,
  });
  return toTokens(raw);
}

/** Step 3 (repeatable): mint a fresh access token from the refresh token. */
export async function refreshTokens(tokens: Tokens): Promise<Tokens> {
  if (!tokens.refreshToken) throw new Error("No refresh token available — re-authenticate");
  const raw = await postToken({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: CLIENT_ID,
  });
  return toTokens(raw, tokens);
}

/**
 * Stateful client: holds tokens, refreshes them automatically before expiry,
 * and optionally persists them to a JSON file.
 */
export class ClaudeAuthClient {
  #tokens: Tokens | null = null;
  #tokenFile: string | null;

  constructor(options: { tokenFile?: string } = {}) {
    this.#tokenFile = options.tokenFile ?? null;
    if (this.#tokenFile) {
      try {
        this.#tokens = JSON.parse(readFileSync(this.#tokenFile, "utf8")) as Tokens;
      } catch {
        // no saved tokens yet
      }
    }
  }

  get tokens(): Tokens | null {
    return this.#tokens;
  }

  setTokens(tokens: Tokens): void {
    this.#tokens = tokens;
    if (this.#tokenFile) {
      mkdirSync(dirname(this.#tokenFile), { recursive: true });
      writeFileSync(this.#tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    }
  }

  /** Complete the interactive login: exchange the pasted code and store the tokens. */
  async login(pasted: string, request: AuthorizationRequest): Promise<Tokens> {
    const tokens = await exchangeCode(pasted, request);
    this.setTokens(tokens);
    return tokens;
  }

  /** Force a refresh now and store the result. */
  async refresh(): Promise<Tokens> {
    if (!this.#tokens) throw new Error("Not authenticated — run login first");
    const tokens = await refreshTokens(this.#tokens);
    this.setTokens(tokens);
    return tokens;
  }

  /** Return a valid access token, refreshing transparently if it is (nearly) expired. */
  async getAccessToken(): Promise<string> {
    if (!this.#tokens) throw new Error("Not authenticated — run login first");
    const expired =
      this.#tokens.expiresAt !== 0 && Date.now() >= this.#tokens.expiresAt - EXPIRY_SKEW_MS;
    if (expired) await this.refresh();
    return this.#tokens.accessToken;
  }

  /**
   * Headers for calling the Anthropic API with this account token.
   * Extra `anthropic-beta` flags (e.g. the managed-agents beta) are appended
   * to the required `oauth-2025-04-20` flag.
   */
  async authHeaders(extraBeta: string[] = []): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.getAccessToken()}`,
      "anthropic-beta": ["oauth-2025-04-20", ...extraBeta].join(","),
      "anthropic-version": "2023-06-01",
    };
  }

  /**
   * Authenticated fetch against api.anthropic.com. Prepends API_BASE to a
   * leading-slash path, attaches auth + beta headers, and refreshes the token
   * transparently. Throws with the status + body on a non-2xx response.
   */
  async apiFetch(
    path: string,
    init: RequestInit & { beta?: string[] } = {},
  ): Promise<Response> {
    const { beta = [], headers, ...rest } = init;
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const res = await fetch(url, {
      ...rest,
      headers: { ...(await this.authHeaders(beta)), ...headers },
    });
    if (!res.ok) {
      throw new Error(`${rest.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
    }
    return res;
  }
}
