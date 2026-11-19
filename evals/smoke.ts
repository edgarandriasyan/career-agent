import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { requestParams } from "../src/agent";
import { costUsd } from "../src/spend";

/*
 * Smoke test: npm run smoke -- --model <id> --budget <usd> [--repeat n]
 *
 * Sends production-shaped requests (same requestParams as answer()) with a public question, `--repeat`
 * times (default 2, in one process, so the second call lands inside the cache window), and prints for
 * each call every stream event type seen (to confirm the citation delta is "citations_delta"), the
 * reply, the stop reason, usage and cost. The second call should show the cache write turned into a
 * cache read. Paid: get Edgar's approval first. `--budget` is required; the next call is refused once
 * spend reaches it.
 * The SDK reads ANTHROPIC_API_KEY itself; this file never reads or prints it.
 */

/** Runs `call` (which returns its cost) up to `repeat` times, refusing the next call once spend reaches the budget. */
export async function smokeLoop(repeat: number, budgetUsd: number, call: () => Promise<number>): Promise<{ spentUsd: number; calls: number; stoppedForBudget: boolean }> {
  let spentUsd = 0;
  let calls = 0;
  while (calls < repeat) {
    if (spentUsd >= budgetUsd) return { spentUsd, calls, stoppedForBudget: true };
    spentUsd += await call();
    calls++;
  }
  return { spentUsd, calls, stoppedForBudget: false };
}

async function smokeCall(client: Anthropic, model: string, career: string): Promise<number> {
  const stream = client.messages.stream(
    requestParams({ career, history: [], question: "What was Edgar's most recent role?", model, blocklist: [] }),
  );
  const seen = new Set<string>();
  for await (const ev of stream) {
    seen.add(ev.type === "content_block_delta" ? `content_block_delta/${ev.delta.type}` : ev.type);
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") process.stdout.write(ev.delta.text);
  }
  const msg = await stream.finalMessage();
  const u = msg.usage;
  const usage = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
  const cost = costUsd(model, usage);
  console.log(`\n\nevent types: ${[...seen].join(", ")}`);
  console.log(`citations_delta seen: ${seen.has("content_block_delta/citations_delta")}`);
  console.log(`stop_reason: ${msg.stop_reason}`);
  console.log(`usage: ${JSON.stringify(usage)}  cost $${cost.toFixed(5)}`);
  return cost;
}

async function main() {
  const { values } = parseArgs({ options: { model: { type: "string" }, budget: { type: "string" }, repeat: { type: "string", default: "2" } } });
  const budgetUsd = Number(values.budget);
  const repeat = Number(values.repeat);
  if (!values.model || !(budgetUsd > 0) || !Number.isInteger(repeat) || repeat < 1) {
    console.error("Usage: npm run smoke -- --model <id> --budget <usd> [--repeat n]");
    process.exit(1);
  }
  const model = values.model;
  const career = readFileSync(fileURLToPath(new URL("../corpus/career.md", import.meta.url)), "utf8");
  const client = new Anthropic();
  const out = await smokeLoop(repeat, budgetUsd, () => smokeCall(client, model, career));
  console.log(`\n${out.calls} call(s), spent $${out.spentUsd.toFixed(5)} of $${budgetUsd}${out.stoppedForBudget ? " (stopped for budget)" : ""}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
