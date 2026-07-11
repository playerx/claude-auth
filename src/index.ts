/**
 * Minimal Anthropic account (OAuth 2.0 + PKCE) authentication flow,
 * the same process Claude Code CLI uses:
 *
 *   1. Generate a PKCE verifier/challenge and an authorization URL.
 *   2. Share the URL with the user; they log in at claude.ai and get a code.
 *   3. User pastes the code back (format: "code#state").
 *   4. Exchange the code for access/refresh tokens at Anthropic's token endpoint.
 */
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

// Public OAuth client ID used by Claude Code CLI
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthorizeUrl(challenge: string, state: string): string {
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
  return `${AUTHORIZE_URL}?${params}`;
}

async function exchangeCode(pasted: string, verifier: string, state: string): Promise<TokenResponse> {
  // The page shows the code as "authorizationCode#state"
  const [code, returnedState] = pasted.trim().split("#");
  if (!code) throw new Error("Empty authorization code");
  if (returnedState && returnedState !== state) throw new Error("State mismatch — possible CSRF, aborting");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state: returnedState ?? state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

async function main() {
  const { verifier, challenge } = generatePkce();
  const state = base64url(randomBytes(32));

  console.log("Open this URL in your browser and authorize:\n");
  console.log(buildAuthorizeUrl(challenge, state));
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = await rl.question("Paste the authorization code here: ");
  rl.close();

  const tokens = await exchangeCode(pasted, verifier, state);

  console.log("\nAuthenticated successfully!");
  console.log(`access_token:  ${tokens.access_token}`);
  if (tokens.refresh_token) console.log(`refresh_token: ${tokens.refresh_token}`);
  if (tokens.expires_in) console.log(`expires_in:    ${tokens.expires_in}s`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
