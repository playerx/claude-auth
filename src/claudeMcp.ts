/**
 * Read the user's MCP servers (requires the `user:mcp_servers`
 * scope) and prepare the `mcpOAuth` map Claude Code stores in
 * ~/.claude.json:
 *
 *   listMcpServers()   -> GET /v1/mcp_servers (raw server list)
 *   prepareMcpOAuth()  -> per server: OAuth discovery (RFC 9728 +
 *                         RFC 8414) + dynamic client registration
 *                         (RFC 7591) -> mcpOAuth entries keyed by
 *                         `serverName|sha256(config)[:16]`
 */
import { createHash } from "node:crypto";
import { claude } from "./claude";

export const MCP_SERVERS_BETA = "mcp-servers-2025-12-04";
/** Default MCP OAuth callback used by Claude Code CLI (port 3118). */
export const MCP_REDIRECT_URI = "http://localhost:3118/callback";

const DISCOVERY_TIMEOUT_MS = 10_000;

export interface McpServer {
  id: string;
  url: string;
  display_name: string;
  icon_url?: string;
  stateless?: boolean;
}

export interface McpOAuthEntry {
  serverName: string;
  serverUrl: string;
  accessToken: string;
  discoveryState: {
    authorizationServerUrl: string;
    oauthMetadataFound: boolean;
  };
  clientId: string;
  redirectUri: string;
}

/** List the MCP servers configured on the user's Anthropic account. */
export async function listMcpServers(): Promise<McpServer[]> {
  const res = await claude.apiFetch("/v1/mcp_servers?limit=1000", {
    beta: [MCP_SERVERS_BETA],
  });
  const body = (await res.json()) as { data: McpServer[] };
  return body.data;
}

/**
 * Key derivation used by Claude Code for `mcpOAuth` entries:
 * `${serverName}|${sha256(JSON.stringify({type, url, headers}))[:16]}`
 */
export function mcpOAuthKey(
  serverName: string,
  config: {
    type: string;
    url: string;
    headers?: Record<string, string>;
  },
): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        type: config.type,
        url: config.url,
        headers: config.headers || {},
      }),
    )
    .digest("hex")
    .substring(0, 16);
  return `${serverName}|${hash}`;
}

/** Claude Code allows only [a-zA-Z0-9_-] in MCP server names. */
function sanitizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

interface DiscoveryResult {
  authorizationServerUrl: string;
  oauthMetadataFound: boolean;
  registrationEndpoint?: string;
}

/**
 * OAuth discovery for an MCP server:
 * 1. Protected-resource metadata (RFC 9728) — path-inserted
 *    well-known first, then root — to find the authorization server.
 *    Falls back to the server's own origin.
 * 2. Authorization-server metadata (RFC 8414 / OIDC) for
 *    `oauthMetadataFound` and the registration endpoint.
 */
export async function discoverOAuth(
  serverUrl: string,
): Promise<DiscoveryResult> {
  const server = new URL(serverUrl);
  let authorizationServerUrl = `${server.origin}/`;

  for (const candidate of [
    `${server.origin}/.well-known/oauth-protected-resource${server.pathname}`,
    `${server.origin}/.well-known/oauth-protected-resource`,
  ]) {
    const meta = await fetchJson(candidate);
    const issuer = meta?.authorization_servers?.[0];
    if (typeof issuer === "string" && issuer) {
      authorizationServerUrl = issuer;
      break;
    }
  }

  const issuer = new URL(authorizationServerUrl);
  const issuerPath = issuer.pathname.replace(/\/$/, "");
  let metadata: any = null;
  for (const candidate of [
    `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuer.origin}${issuerPath}/.well-known/openid-configuration`,
  ]) {
    metadata = await fetchJson(candidate);
    if (metadata?.authorization_endpoint) break;
    metadata = null;
  }

  return {
    authorizationServerUrl,
    oauthMetadataFound: metadata !== null,
    registrationEndpoint: metadata?.registration_endpoint,
  };
}

/** Dynamic client registration (RFC 7591); returns the client_id. */
export async function registerOAuthClient(
  registrationEndpoint: string,
  serverName: string,
  redirectUri = MCP_REDIRECT_URI,
): Promise<string> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `Claude Code (${serverName})`,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `Client registration at ${registrationEndpoint} failed ` +
        `${res.status}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

/**
 * Fetch the user's MCP servers and prepare the `mcpOAuth` map:
 * discovery + client registration per server, `accessToken` left
 * empty (it is filled by the interactive authorization flow later).
 */
export async function prepareMcpOAuth(): Promise<
  Record<string, McpOAuthEntry>
> {
  const servers = await listMcpServers();

  const entries = await Promise.all(
    servers.map(async (server) => {
      const serverName = sanitizeServerName(server.display_name);
      try {
        const discovery = await discoverOAuth(server.url);
        const clientId = discovery.registrationEndpoint
          ? await registerOAuthClient(
              discovery.registrationEndpoint,
              serverName,
            )
          : "";
        const entry: McpOAuthEntry = {
          serverName,
          serverUrl: server.url,
          accessToken: "",
          discoveryState: {
            authorizationServerUrl: discovery.authorizationServerUrl,
            oauthMetadataFound: discovery.oauthMetadataFound,
          },
          clientId,
          redirectUri: MCP_REDIRECT_URI,
        };
        return [
          mcpOAuthKey(serverName, { type: "http", url: server.url }),
          entry,
        ] as const;
      } catch (err) {
        console.warn(`mcpOAuth: skipping ${serverName} (${server.url}):`, err);
        return null;
      }
    }),
  );

  return Object.fromEntries(entries.filter((e) => e !== null));
}
