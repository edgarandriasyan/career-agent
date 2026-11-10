import { expect, test } from "vitest";
import { z } from "zod";
import type { ClaudeRequest } from "../judges/request";
import { ClaudeJudge, JudgeRefusalError, JudgeTruncatedError } from "./claude-judge";
import { fakeClient, text } from "./fake-client";

const Schema = z.object({ verdict: z.enum(["yes", "no"]), reason: z.string() });

test("ClaudeJudge sends no temperature or thinking, effort low, max_tokens 8192, json_schema format", async () => {
  const seen: ClaudeRequest[] = [];
  const judge = new ClaudeJudge({ model: "claude-haiku-5-5", client: fakeClient([{ content: text('{"verdict":"yes","reason":"r"}'), usage: { input_tokens: 1_000_000, output_tokens: 0 } }], seen) });
  const r = await judge.generate("PROMPT", Schema);
  expect(r.output).toEqual({ verdict: "yes", reason: "r" });
  expect(r.cost).toBeCloseTo(0.1);
  expect(judge.getModelName()).toBe("claude-haiku-5-5");
  expect(seen).toHaveLength(1);
  const req = seen[0] as Record<string, unknown>;
  for (const k of ["temperature", "top_p", "top_k", "thinking", "system", "tool_choice", "tools", "fallbacks", "stop_sequences"]) expect(req, k).not.toHaveProperty(k);
  expect(req.model).toBe("claude-haiku-5-5");
  expect(req.max_tokens).toBe(8192);
  expect(req.messages).toEqual([{ role: "user", content: "PROMPT" }]);
  expect(seen[0].output_config.effort).toBe("low");
  expect(seen[0].output_config.format?.type).toBe("json_schema");
  expect(seen[0].output_config.format?.schema).toMatchObject({ type: "object", properties: { verdict: { enum: ["yes", "no"] } } });

  const plain = await judge.generate("PLAIN");
  expect(plain.output).toBe('{"verdict":"yes","reason":"r"}');
  expect(seen[1].output_config).toEqual({ effort: "low" });
  expect(judge.calls).toBe(2);
  expect(judge.costUsd).toBeCloseTo(0.2);
});

test("ClaudeJudge throws on refusal and max_tokens", async () => {
  const judge = new ClaudeJudge({
    model: "claude-sonnet-5-5",
    client: fakeClient([{ stop_reason: "refusal", content: text('{"verdict":"yes","reason":"r"}') }, { stop_reason: "max_tokens", content: text('{"verdict":"yes","reason":"r"}') }, { stop_reason: "model_context_window_exceeded" }]),
  });
  await expect(judge.generate("P", Schema)).rejects.toBeInstanceOf(JudgeRefusalError);
  await expect(judge.generate("P", Schema)).rejects.toBeInstanceOf(JudgeTruncatedError);
  await expect(judge.generate("P")).rejects.toBeInstanceOf(JudgeTruncatedError);
  expect({ calls: judge.calls, refusals: judge.refusals, truncations: judge.truncations }).toEqual({ calls: 3, refusals: 1, truncations: 2 });
});

const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

test("ClaudeJudge retries once without format when the schema is rejected, and counts it", async () => {
  const seen: ClaudeRequest[] = [];
  const judge = new ClaudeJudge({
    model: "claude-sonnet-5-5",
    client: fakeClient([badRequest("output_config.format.schema: unsupported keyword"), { content: text('Here it is: {"verdict":"no","reason":"r"} done') }], seen),
  });
  expect((await judge.generate("P", Schema)).output).toEqual({ verdict: "no", reason: "r" });
  expect(seen).toHaveLength(2);
  expect(seen[0].output_config.format).toBeDefined();
  expect(seen[1].output_config).toEqual({ effort: "low" });
  expect(judge.schemaRetries).toBe(1);
  expect(judge.calls).toBe(2);

  // Only one retry, and only for a schema rejection.
  const twice = new ClaudeJudge({ model: "claude-sonnet-5-5", client: fakeClient([badRequest("output_config.format: bad schema")]) });
  await expect(twice.generate("P", Schema)).rejects.toThrow("schema");
  expect(twice.calls).toBe(2);
  const other = new ClaudeJudge({ model: "claude-sonnet-5-5", client: fakeClient([badRequest("messages: at least one message is required")]) });
  await expect(other.generate("P", Schema)).rejects.toThrow("messages");
  expect({ calls: other.calls, schemaRetries: other.schemaRetries }).toEqual({ calls: 1, schemaRetries: 0 });
});

test("ClaudeJudge output that does not match the schema is an error, not a value", async () => {
  const judge = new ClaudeJudge({ model: "claude-sonnet-5-5", client: fakeClient([{ content: text('{"verdict":"maybe"}') }]) });
  await expect(judge.generate("P", Schema)).rejects.toThrow();
});
