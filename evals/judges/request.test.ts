import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { buildJudgeRequest, judgePromptHash, judgePromptText, parseJudgeResponse, VERDICT_SCHEMA, type JudgeResponse } from "./request";
import type { JudgeSpec } from "./spec";

const spec: JudgeSpec = {
  id: "T_test",
  criterion: "CRITERION-TEXT",
  pass: "PASS-DEF",
  fail: "FAIL-DEF",
  inputs: ["reply", "rubric"],
  examples: [
    { input: { reply: "EXAMPLE-REPLY", rubric: "EXAMPLE-RUBRIC" }, critique: "EXAMPLE-CRITIQUE", result: "Pass" },
  ],
};
const input = { question: "SECRET-QUESTION", history: [{ role: "user" as const, text: "HISTORY-TEXT" }], reply: "REPLY-TEXT", rubric: "RUBRIC-TEXT" };
const res = (o: Partial<JudgeResponse>): JudgeResponse => ({ stop_reason: "end_turn", content: [], ...o });
const text = (t: string) => [{ type: "text", text: t }];

test("request has json_schema format with critique before result, max_tokens 8192, effort low, no sampling params, no tools", () => {
  const r = buildJudgeRequest(spec, input, "claude-sonnet-5-5", "CORPUS-TEXT");
  expect(r.model).toBe("claude-sonnet-5-5");
  expect(r.max_tokens).toBe(8192);
  expect(r.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: VERDICT_SCHEMA } });
  expect(Object.keys(VERDICT_SCHEMA.properties)).toEqual(["critique", "result"]);
  expect(VERDICT_SCHEMA.required).toEqual(["critique", "result"]);
  expect(VERDICT_SCHEMA.additionalProperties).toBe(false);
  expect(VERDICT_SCHEMA.properties.result.enum).toEqual(["Pass", "Fail"]);
  for (const k of ["temperature", "top_p", "top_k", "thinking", "tools", "tool_choice", "fallbacks"]) expect(r).not.toHaveProperty(k);
  expect(r.messages.map((m) => m.role)).toEqual(["user"]); // no assistant prefill
});

test("corpus is a cached system block; only the spec's inputs reach the user message", () => {
  const r = buildJudgeRequest(spec, input, "claude-sonnet-5-5", "CORPUS-TEXT");
  // the source document comes first, so every judge on a model shares one cache entry
  expect(r.system[0]).toEqual({ type: "text", text: "<corpus>\nCORPUS-TEXT\n</corpus>", cache_control: { type: "ephemeral" } });
  const inst = r.system[1];
  expect(inst.cache_control).toEqual({ type: "ephemeral" });
  expect(inst.text).toContain("CRITERION-TEXT");
  expect(inst.text).toContain("PASS-DEF");
  expect(inst.text).toContain("FAIL-DEF");
  expect(inst.text).toMatch(/data/);
  expect(inst.text).not.toContain("CORPUS-TEXT");
  const user = r.messages[0].content;
  expect(user).toContain("<reply>\nREPLY-TEXT\n</reply>");
  expect(user).toContain("<rubric>\nRUBRIC-TEXT\n</rubric>");
  expect(user).not.toContain("CORPUS-TEXT");
  // J0 never sends the question or the history
  const sent = JSON.stringify(r);
  expect(sent).not.toContain("SECRET-QUESTION");
  expect(sent).not.toContain("HISTORY-TEXT");
  // context replaces the corpus for RAG arms
  const rag = buildJudgeRequest(spec, { ...input, context: "CONTEXT-TEXT" }, "claude-sonnet-5-5", "CORPUS-TEXT");
  expect(rag.system[0].text).toBe("<context>\nCONTEXT-TEXT\n</context>");
  expect(JSON.stringify(rag)).not.toContain("CORPUS-TEXT");
});

test("two different judges send an identical first system block", () => {
  const other: JudgeSpec = { ...spec, id: "T_other", criterion: "OTHER", inputs: ["question", "reply"], examples: [] };
  for (const i of [input, { ...input, context: "CONTEXT-TEXT" }]) {
    const a = buildJudgeRequest(spec, i, "claude-sonnet-5-5", "CORPUS-TEXT");
    const b = buildJudgeRequest(other, i, "claude-sonnet-5-5", "CORPUS-TEXT");
    expect(JSON.stringify(b.system[0])).toBe(JSON.stringify(a.system[0]));
    expect(b.system[1].text).not.toBe(a.system[1].text);
  }
});

test("question and history reach the user message when the spec asks for them", () => {
  const r = buildJudgeRequest({ ...spec, inputs: ["question", "history", "reply"] }, input, "claude-haiku-5-5", "C");
  const user = r.messages[0].content;
  expect(user).toContain("<question>\nSECRET-QUESTION\n</question>");
  expect(user).toContain("HISTORY-TEXT");
  expect(user).not.toContain("RUBRIC-TEXT");
});

test("an empty reply is shown as a placeholder, not an empty tag", () => {
  const r = buildJudgeRequest(spec, { reply: "", rubric: "r" }, "claude-sonnet-5-5", "C");
  expect(r.messages[0].content).toContain("(no reply;");
});

test("a valid verdict parses, critique first", () => {
  const v = parseJudgeResponse(res({ content: text('{"critique": "quotes X and line Y", "result": "Fail"}') }), spec, "claude-sonnet-5-5");
  expect(v).toEqual({ judgeId: "T_test", model: "claude-sonnet-5-5", pass: false, critique: "quotes X and line Y" });
  const p = parseJudgeResponse(res({ content: [{ type: "thinking" }, ...text('{"critique": "ok", "result": "Pass"}')] }), spec, "claude-sonnet-5-5");
  expect(p.pass).toBe(true);
});

test("refusal stop returns an error, not a verdict", () => {
  const v = parseJudgeResponse(res({ stop_reason: "refusal", content: text('{"critique": "x", "result": "Pass"}') }), spec, "claude-sonnet-5-5");
  expect(v.pass).toBeNull();
  expect(v.error).toBe("refusal");
});

test("max_tokens stop returns error max_tokens", () => {
  const v = parseJudgeResponse(res({ stop_reason: "max_tokens", content: text('{"critique": "cut') }), spec, "claude-sonnet-5-5");
  expect(v).toMatchObject({ pass: null, error: "max_tokens" });
  expect(parseJudgeResponse(res({ stop_reason: "model_context_window_exceeded" }), spec, "claude-sonnet-5-5").error).toBe("max_tokens");
});

test("output that does not match the schema is an invalid error, never a Pass", () => {
  for (const t of ["looks good", '{"result": "Pass"}', '{"critique": "x", "result": "pass"}', '{"critique": 1, "result": "Pass"}'])
    expect(parseJudgeResponse(res({ content: text(t) }), spec, "claude-sonnet-5-5")).toMatchObject({ pass: null, error: "invalid" });
});

test("examples render inside <examples> before the case", () => {
  const r = buildJudgeRequest(spec, input, "claude-sonnet-5-5", "C");
  const sys = r.system[1].text;
  const open = sys.indexOf("<examples>");
  const close = sys.indexOf("</examples>");
  expect(open).toBeGreaterThanOrEqual(0);
  for (const s of ["EXAMPLE-REPLY", "EXAMPLE-RUBRIC", "EXAMPLE-CRITIQUE"]) {
    expect(sys.indexOf(s)).toBeGreaterThan(open);
    expect(sys.indexOf(s)).toBeLessThan(close);
  }
  // the case comes after the instructions and examples (system), in the user message
  expect(buildJudgeRequest({ ...spec, examples: [] }, input, "claude-sonnet-5-5", "C").system[1].text).not.toContain("<examples>");
  expect(sys).not.toContain("REPLY-TEXT");
  expect(r.messages[0].content).not.toContain("EXAMPLE-REPLY");
});

test("prompt hash changes when any example changes", async () => {
  const h = await judgePromptHash(spec);
  expect(h).toMatch(/^[0-9a-f]{12}$/);
  expect(await judgePromptHash({ ...spec })).toBe(h);
  const ex = spec.examples[0];
  expect(await judgePromptHash({ ...spec, examples: [{ ...ex, critique: "other" }] })).not.toBe(h);
  expect(await judgePromptHash({ ...spec, examples: [{ ...ex, result: "Fail" }] })).not.toBe(h);
  expect(await judgePromptHash({ ...spec, examples: [{ ...ex, input: { ...ex.input, reply: "other" } }] })).not.toBe(h);
  expect(await judgePromptHash({ ...spec, examples: [...spec.examples, ex] })).not.toBe(h);
  expect(await judgePromptHash({ ...spec, criterion: "other" })).not.toBe(h);
  expect(await judgePromptHash({ ...spec, inputs: ["reply"] })).not.toBe(h);
});

test("prompt hash covers the output schema, effort and max_tokens", () => {
  const t = judgePromptText(spec);
  const r = buildJudgeRequest(spec, input, "claude-sonnet-5-5", "C");
  expect(t).toContain(JSON.stringify(r.output_config.format.schema));
  expect(t).toContain(`"effort":"${r.output_config.effort}"`);
  expect(t).toContain(`"max_tokens":${r.max_tokens}`);
});

test("request.ts imports nothing from node:* or the SDK", () => {
  for (const f of ["request.ts", "spec.ts", "rubric.ts", "index.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    const imports = [...src.matchAll(/(?:import|export)[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
    for (const i of imports) {
      expect(i, f).not.toMatch(/^node:/);
      expect(i, f).not.toMatch(/^@anthropic-ai\//);
      expect(i.startsWith("."), `${f}: ${i}`).toBe(true);
    }
  }
});
