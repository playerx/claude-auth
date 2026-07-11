/**
 * CLI demo for the SDK in ./sdk.ts
 *
 *   node src/index.ts login    interactive flow: print URL, paste code, save tokens
 *   node src/index.ts token    print a valid access token (auto-refreshes if expired)
 *   node src/index.ts refresh  force a refresh and save the new tokens
 *   node src/index.ts whoami   call the API with the token to prove it works
 */
import { createInterface } from "node:readline/promises";
import { ClaudeAuthClient, createAuthorizationRequest } from "./sdk.ts";

const client = new ClaudeAuthClient({ tokenFile: "tokens.json" });

async function login() {
  const request = createAuthorizationRequest();
  console.log("Open this URL in your browser and authorize:\n");
  console.log(request.url);
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = await rl.question("Paste the authorization code here: ");
  rl.close();

  const tokens = await client.login(pasted, request);
  console.log("\nAuthenticated successfully — tokens saved to tokens.json");
  if (tokens.expiresAt) {
    console.log(`Access token expires at ${new Date(tokens.expiresAt).toISOString()}`);
  }
}

async function token() {
  console.log(await client.getAccessToken());
}

async function refresh() {
  const tokens = await client.refresh();
  console.log("Refreshed — new tokens saved to tokens.json");
  if (tokens.expiresAt) {
    console.log(`Access token expires at ${new Date(tokens.expiresAt).toISOString()}`);
  }
}

async function whoami() {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { ...(await client.authHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 32,
      messages: [{ role: "user", content: "Reply with exactly: token works" }],
    }),
  });
  if (!res.ok) throw new Error(`API call failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  console.log(data.content.find((b) => b.type === "text")?.text ?? JSON.stringify(data));
}

const commands: Record<string, () => Promise<void>> = { login, token, refresh, whoami };
const command = commands[process.argv[2] ?? "login"];

if (!command) {
  console.error(`Unknown command "${process.argv[2]}". Use: login | token | refresh | whoami`);
  process.exit(1);
}

command().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
