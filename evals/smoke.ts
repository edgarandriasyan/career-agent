import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { requestParams } from "../src/agent";
import { costUsd } from "../src/spend";

/*
 * One-call smoke test: npm run smoke -- --model <id>
 *
 * Sends one production-shaped request (same requestParams as answer()) with a public question and
 * prints every stream event type seen (to confirm the citation delta is "citations_delta"), the
 * reply, the stop reason, usage and cost. This is a paid call: get Edgar's approval first. Run it
 * twice within five minutes to see the cache write turn into a cache read.
 * The SDK reads ANTHROPIC_API_KEY itself; this file never reads or prints it.
 */

const { values } = parseArgs({ options: { model: { type: "string" } } });
if (!values.model) {
  console.error("Usage: npm run smoke -- --model <id>");
  process.exit(1);
}
const career = readFileSync(fileURLToPath(new URL("../corpus/career.md", import.meta.url)), "utf8");
const stream = new Anthropic().messages.stream(
  requestParams({ career, history: [], question: "What was Edgar's most recent role?", model: values.model, blocklist: [] }),
);

const seen = new Set<string>();
for await (const ev of stream) {
  seen.add(ev.type === "content_block_delta" ? `content_block_delta/${ev.delta.type}` : ev.type);
  if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") process.stdout.write(ev.delta.text);
}
const msg = await stream.finalMessage();
const u = msg.usage;
const usage = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
console.log(`\n\nevent types: ${[...seen].join(", ")}`);
console.log(`citations_delta seen: ${seen.has("content_block_delta/citations_delta")}`);
console.log(`stop_reason: ${msg.stop_reason}`);
console.log(`usage: ${JSON.stringify(usage)}  cost $${costUsd(values.model, usage).toFixed(5)}`);
