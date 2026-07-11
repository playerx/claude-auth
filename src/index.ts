/**
 * CLI demo for the SDK in ./sdk.ts
 *
 *   node src/index.ts login    interactive flow: print URL, paste code, save tokens
 *   node src/index.ts token    print a valid access token (auto-refreshes if expired)
 *   node src/index.ts refresh  force a refresh and save the new tokens
 *   node src/index.ts whoami   fetch and show account/organization info
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
  const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
    headers: await client.authHeaders(),
  });
  if (!res.ok) throw new Error(`Profile request failed: ${res.status} ${await res.text()}`);

  const profile = (await res.json()) as {
    account?: { uuid?: string; email?: string; full_name?: string; display_name?: string };
    organization?: { uuid?: string; name?: string; organization_type?: string };
  };

  const { account, organization } = profile;
  if (account) {
    console.log("Account:");
    if (account.full_name ?? account.display_name)
      console.log(`  name:  ${account.full_name ?? account.display_name}`);
    if (account.email) console.log(`  email: ${account.email}`);
    if (account.uuid) console.log(`  uuid:  ${account.uuid}`);
  }
  if (organization) {
    console.log("Organization:");
    if (organization.name) console.log(`  name: ${organization.name}`);
    if (organization.organization_type) console.log(`  type: ${organization.organization_type}`);
    if (organization.uuid) console.log(`  uuid: ${organization.uuid}`);
  }

  console.log("\nFull response:");
  console.log(JSON.stringify(profile, null, 2));
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
