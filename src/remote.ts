/**
 * Remote sessions — the buildable core of Claude Code's `claude rc`
 * (remote-control) command.
 *
 * `claude rc` does two things: (1) starts a *remote session* on Anthropic's
 * infrastructure that can be driven from claude.ai/code or the mobile app, and
 * (2) runs a local bridge so those remote turns can execute tools on your
 * machine. This module implements (1): create a session, print the control
 * URL, stream the agent's events, and send messages from the terminal. The
 * local tool-execution bridge is out of scope.
 *
 * Endpoints (Managed Agents / `managed-agents-2026-04-01` beta), the same ones
 * the Claude Code binary calls:
 *   POST /v1/sessions
 *   POST /v1/sessions/{id}/events
 *   GET  /v1/sessions/{id}/events/stream   (Server-Sent Events)
 */
import { MANAGED_AGENTS_BETA, type ClaudeAuthClient } from "./sdk.ts";

const BETA = [MANAGED_AGENTS_BETA];

export interface Session {
  id: string;
  status?: string;
  title?: string;
}

/** One decoded Server-Sent Event from the session stream. */
export interface SessionEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Create a remote session. `agent` and `environmentId` come from your
 * workspace's Managed Agents setup (create them once with the `ant` CLI or the
 * agents/environments API, then reuse the IDs).
 */
export async function createSession(
  client: ClaudeAuthClient,
  opts: { agent: string; environmentId: string; title?: string },
): Promise<Session> {
  const res = await client.apiFetch("/v1/sessions", {
    method: "POST",
    beta: BETA,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: opts.agent,
      environment_id: opts.environmentId,
      title: opts.title,
    }),
  });
  return (await res.json()) as Session;
}

/** URL to drive this session from claude.ai/code (or the mobile app). */
export function controlUrl(sessionId: string): string {
  return `https://claude.ai/code/sessions/${sessionId}`;
}

/** Send a user message into a running session. */
export async function sendUserMessage(
  client: ClaudeAuthClient,
  sessionId: string,
  text: string,
): Promise<void> {
  await client.apiFetch(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    beta: BETA,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
}

/**
 * Async-iterate the session's SSE event stream. Yields one decoded event per
 * `data:` line until the connection closes.
 */
export async function* streamEvents(
  client: ClaudeAuthClient,
  sessionId: string,
  signal?: AbortSignal,
): AsyncGenerator<SessionEvent> {
  const res = await client.apiFetch(`/v1/sessions/${sessionId}/events/stream`, {
    beta: BETA,
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!res.body) return;

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data) as SessionEvent;
      } catch {
        // ignore keep-alive / non-JSON frames
      }
    }
  }
}
