# claude-auth

Minimal TypeScript SDK + CLI implementing the **Anthropic account authentication flow** — the same OAuth 2.0 + PKCE process Claude Code CLI uses. You generate a login link, share it with the user, they paste back the code shown after authorizing, and the app exchanges it for access/refresh tokens. Refresh is handled automatically.

No runtime dependencies. Node 22+ runs the `.ts` files directly (built-in type stripping).

## How it works

The flow is standard **OAuth 2.0 authorization code with PKCE** against Anthropic's endpoints, using Claude Code's public client ID (`9d1c250a-e61b-44d9-88ed-5944d1962f5e`). PKCE means no client secret is needed — safe for a CLI/native app.

```
┌──────────┐  1. authorize URL (with PKCE challenge + state)   ┌─────────┐
│  this    │ ────────────────────────────────────────────────► │  user's │
│  app     │                                                   │ browser │
│          │  2. user logs in at claude.ai, approves scopes    └────┬────┘
│          │     callback page shows a code:  "code#state"          │
│          │ ◄──────── 3. user pastes the code back ────────────────┘
│          │
│          │  4. POST code + PKCE verifier ──► console.anthropic.com/v1/oauth/token
│          │ ◄──── access_token + refresh_token + expires_in
└──────────┘
```

Step by step:

1. **Authorization request** — the app generates a random PKCE *verifier*, hashes it (SHA-256, base64url) into a *challenge*, plus a random *state*, and builds a URL to `https://claude.ai/oauth/authorize` with the challenge, the state, and the scopes `org:create_api_key user:profile user:inference`. This URL is what you share with the user.
2. **User authorizes** — they log into their Anthropic account and approve. The callback page (`console.anthropic.com/oauth/code/callback`) displays an authorization code in the form `code#state` for the user to copy.
3. **Code exchange** — the app checks the returned `state` matches the one it generated (CSRF protection), then POSTs the code together with the original PKCE *verifier* to `https://console.anthropic.com/v1/oauth/token`. The server hashes the verifier and compares it to the challenge from step 1 — proof the exchange comes from the same app that started the flow.
4. **Tokens** — the response contains a short-lived `access_token`, a long-lived `refresh_token`, and `expires_in`. They are saved to `tokens.json` (mode 0600).
5. **Refresh** — when the access token is within 60 s of expiry, the SDK transparently POSTs `grant_type: refresh_token` to the same token endpoint and stores the new tokens. Your code never has to think about expiry.

### Using the token

Account OAuth tokens are sent as a Bearer header, **not** `x-api-key`, and require the OAuth beta header:

```
Authorization: Bearer <access_token>
anthropic-beta: oauth-2025-04-20
anthropic-version: 2023-06-01
```

`ClaudeAuthClient.authHeaders()` returns exactly these.

## CLI usage

```bash
npm install          # dev deps only (typescript for typechecking)

node src/index.ts login    # print the URL, paste the code back, save tokens.json
node src/index.ts token    # print a valid access token (auto-refreshes if expired)
node src/index.ts refresh  # force a refresh now
node src/index.ts whoami   # fetch and show account/organization info for the logged-in user
```

Each `login` run generates a fresh verifier/state, so paste the code into the same run that printed the URL.

## SDK usage

```ts
import {
  ClaudeAuthClient,
  createAuthorizationRequest,
  exchangeCode,
  refreshTokens,
} from "./src/sdk.ts";

// --- One-time interactive login ---------------------------------------
const client = new ClaudeAuthClient({ tokenFile: "tokens.json" });

const request = createAuthorizationRequest();
console.log("Authorize here:", request.url);
const pasted = await askUserSomehow(); // the "code#state" string
await client.login(pasted, request);   // exchanges + persists tokens

// --- Every subsequent run ----------------------------------------------
// tokens.json is loaded in the constructor; refresh happens automatically
const client2 = new ClaudeAuthClient({ tokenFile: "tokens.json" });

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { ...(await client2.authHeaders()), "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 100,
    messages: [{ role: "user", content: "Hello!" }],
  }),
});
```

Stateless functions are also exported if you want to manage token storage yourself: `createAuthorizationRequest()`, `exchangeCode(pasted, request)`, `refreshTokens(tokens)`.

### API

| Export | What it does |
|---|---|
| `createAuthorizationRequest()` | Returns `{ url, verifier, state }`. Share `url`; keep `verifier`/`state` for the exchange. |
| `exchangeCode(pasted, request)` | Validates state, exchanges the code, returns `Tokens`. |
| `refreshTokens(tokens)` | Mints a new access token from `tokens.refreshToken`. Keeps the old refresh token if the server doesn't rotate it. |
| `new ClaudeAuthClient({ tokenFile? })` | Stateful client. Loads tokens from `tokenFile` if present. |
| `client.login(pasted, request)` | Exchange + persist. |
| `client.getAccessToken()` | Valid access token; auto-refreshes within 60 s of expiry. |
| `client.authHeaders()` | Ready-to-use headers for `api.anthropic.com`. |
| `client.refresh()` | Force refresh + persist. |

## Security notes

- `tokens.json` grants access to your Anthropic account — treat it like a password. It is written with file mode `0600` and should never be committed (see `.gitignore`).
- The `state` check protects against CSRF; PKCE protects against authorization-code interception. Don't remove either.
- Tokens are short-lived by design; revoke access any time from your Anthropic account settings.
