import { fileURLToPath } from "node:url";
import { register } from "@arizeai/phoenix-otel";
import { makeAgent } from "../src/eval-agent";
import type { AgentEvent, FallbackReason, Msg } from "../src/types";
import { PHOENIX_URL, phoenixUp, usePhoenixEnv } from "./phoenix/env";
import { withCaseSpan } from "./phoenix/trace";
import type { AgentFn } from "./run";

/*
 * The bot as a command, for the Python ConversationSimulator (DeepEval's model_callback runs this as a
 * subprocess, one call per turn):
 *
 *   echo '{"model":"claude-haiku-5-5","question":"...","history":[],"sessionId":"s1"}' | ../private/evals/with-key.sh npx tsx evals/bot-cli.ts
 *
 * stdout is exactly one JSON line (nothing else is ever written there; diagnostics go to stderr): { reply, sources, fallback?, costUsd }. The reply is the visible text only (the
 * sentences the visitor would see): the raw model text tap is not passed, and a fallback is its reason only.
 * Errors go to stderr as a short message without the input. A real run is a paid call: Edgar's approval first.
 * The Phoenix env is always set and asserted; when the local server answers, the turn is a `case` span
 * (grouped into a Phoenix session by sessionId), and the SDK's own span under it holds the raw text there.
 */

export type BotInput = { model: string; question: string; history: Msg[]; sessionId?: string };
export type BotOutput = { reply: string; sources: string[]; fallback?: FallbackReason; costUsd: number };

const MODEL = /^claude-(haiku|sonnet|opus)-5-5$/;
const isMsg = (m: unknown): m is Msg =>
  !!m && typeof m === "object" && ((m as Msg).role === "user" || (m as Msg).role === "assistant") && typeof (m as Msg).text === "string";

export function parseInput(text: string): BotInput {
  let v: Partial<BotInput>;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("invalid JSON on stdin");
  }
  if (typeof v?.model !== "string" || !MODEL.test(v.model)) throw new Error("model must be claude-haiku-5-5, claude-sonnet-5-5 or claude-opus-5-5");
  if (typeof v.question !== "string" || !v.question) throw new Error("question must be a non-empty string");
  if (!Array.isArray(v.history) || !v.history.every(isMsg)) throw new Error("history must be a list of { role, text }");
  if (v.sessionId !== undefined && typeof v.sessionId !== "string") throw new Error("sessionId must be a string");
  return { model: v.model, question: v.question, history: v.history, ...(v.sessionId ? { sessionId: v.sessionId } : {}) };
}

export function botOutput(events: AgentEvent[]): BotOutput {
  const sentences = events.flatMap((e) => (e.type === "sentence" ? [e] : []));
  const fallback = events.find((e) => e.type === "fallback");
  return {
    reply: sentences.map((e) => e.text).join(" "),
    sources: [...new Set(sentences.flatMap((e) => e.sources))],
    ...(fallback ? { fallback: fallback.reason } : {}),
    costUsd: events.reduce((s, e) => s + (e.type === "done" ? e.costUsd : 0), 0),
  };
}

export async function runBot(input: BotInput, agent: AgentFn): Promise<BotOutput> {
  const events: AgentEvent[] = [];
  // No onText: raw text (a blocked sentence included) never leaves the agent.
  for await (const e of agent({ id: "bot-cli", category: "multiturn", question: input.question, history: input.history })) events.push(e);
  return botOutput(events);
}

/** Parses the stdin text, runs one turn (a `case` span when traced) and returns the one stdout line. Prints nothing itself. */
export async function runCli(text: string, o: { agent: AgentFn; traced: boolean }): Promise<string> {
  const parsed = parseInput(text);
  const run = () => runBot(parsed, o.agent);
  const out = o.traced
    ? await withCaseSpan(
        (r: BotOutput) => ({
          "input.value": JSON.stringify({ question: parsed.question, history: parsed.history }),
          "input.mime_type": "application/json",
          "output.value": r.reply,
          "output.mime_type": "text/plain",
          "agent.cost_usd": +r.costUsd.toFixed(6),
          ...(r.fallback ? { "agent.fallback.reason": r.fallback } : {}),
        }),
        run,
        parsed.sessionId,
      )
    : await run();
  return JSON.stringify(out);
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try {
    parseInput(input);
  } catch (e) {
    console.error(`bot-cli: ${(e as Error).message}`); // our own messages: they never echo the input
    process.exit(2);
  }
  usePhoenixEnv();
  const provider = (await phoenixUp(PHOENIX_URL))
    ? register({ projectName: "career-agent-evals", url: PHOENIX_URL, batch: false, global: true })
    : undefined;
  try {
    // The only stdout write of the process: the Python caller parses the last line.
    console.log(await runCli(input, { agent: makeAgent(parseInput(input).model), traced: !!provider }));
  } finally {
    await provider?.shutdown();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(`bot-cli: failed (${e instanceof Error ? e.name : "error"})`); // no message: it could echo the input
    process.exit(1);
  });
