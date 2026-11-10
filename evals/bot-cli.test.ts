import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { register } from "@arizeai/phoenix-otel";
import { expect, test, vi } from "vitest";
import type { AgentEvent } from "../src/types";
import { parseInput, runBot, runCli } from "./bot-cli";
import type { AgentFn } from "./run";

const RAW = "RAWBLOCKEDTEXT";
const events: AgentEvent[] = [
  { type: "sentence", text: "He led a team.", sources: ["Moonfare"] },
  { type: "sentence", text: "He shipped it.", sources: ["Moonfare", "Copilot"] },
  { type: "fallback", reason: "blocked", detail: "DETAILWITHPRIVATETERM" },
  { type: "done", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.0125, model: "claude-haiku-5-5" },
];
const seen: { model?: string; question?: string; history?: unknown }[] = [];
const agent: AgentFn = async function* (c, o) {
  seen.push({ question: c.question, history: c.history });
  o?.onText?.(RAW); // a tap the CLI must never pass on
  yield* events;
};

test("bot-cli prints only the visible reply", async () => {
  const out = await runBot({ model: "claude-haiku-5-5", question: "Is he a fit?", history: [{ role: "user", text: "hi" }] }, agent);
  expect(out).toEqual({ reply: "He led a team. He shipped it.", sources: ["Moonfare", "Copilot"], fallback: "blocked", costUsd: 0.0125 });
  const printed = JSON.stringify(out);
  expect(printed).not.toContain(RAW);
  expect(printed).not.toContain("DETAILWITHPRIVATETERM");
  expect(seen.at(-1)).toEqual({ question: "Is he a fit?", history: [{ role: "user", text: "hi" }] });
});

test("a reply with no fallback has no fallback key", async () => {
  const clean: AgentFn = async function* () {
    yield events[0];
    yield events[3];
  };
  const out = await runBot({ model: "claude-haiku-5-5", question: "q", history: [] }, clean);
  expect(out).toEqual({ reply: "He led a team.", sources: ["Moonfare"], costUsd: 0.0125 });
  expect("fallback" in out).toBe(false);
});

test("input must be JSON with a Claude 5.5 model, a question and a history", () => {
  expect(parseInput('{"model":"claude-sonnet-5-5","question":"q","history":[],"sessionId":"s1"}')).toEqual({
    model: "claude-sonnet-5-5", question: "q", history: [], sessionId: "s1",
  });
  expect(() => parseInput("not json")).toThrow("invalid JSON");
  expect(() => parseInput('{"model":"gpt-5.4","question":"q","history":[]}')).toThrow("model");
  expect(() => parseInput('{"model":"claude-haiku-5-5","history":[]}')).toThrow("question");
  expect(() => parseInput('{"model":"claude-haiku-5-5","question":"q","history":[{"role":"system","text":"x"}]}')).toThrow("history");
});

test("the traced path prints nothing itself: runCli returns the single stdout line", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = register({ projectName: "test", spanProcessors: [new SimpleSpanProcessor(exporter)], global: true });
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  const writes = vi.spyOn(process.stdout, "write");
  try {
    const line = await runCli(JSON.stringify({ model: "claude-haiku-5-5", question: "Is he a fit?", history: [], sessionId: "s1" }), { agent, traced: true });
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({ reply: "He led a team. He shipped it.", sources: ["Moonfare", "Copilot"], fallback: "blocked", costUsd: 0.0125 });
    expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    await provider.forceFlush();
    const span = exporter.getFinishedSpans().find((s) => s.name === "case");
    expect(span?.attributes["session.id"]).toBe("s1");
    expect(JSON.stringify(span?.attributes)).not.toContain(RAW);
  } finally {
    vi.restoreAllMocks();
    await provider.shutdown();
  }
});
