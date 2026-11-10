import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { GenerationResult } from "deepeval/models";
import type { ZodType } from "zod";
import { costUsd } from "../../src/spend";
import { defaultJudgeClient, type JudgeClient } from "../judge";
import type { ClaudeRequest, JudgeResponse } from "../judges/request";
import type { JudgeModel } from "../judges/spec";
import { loadDeepEval } from "./env";

/*
 * DeepEval's judge model, on Claude. Every DeepEval metric gets this instance (never a model string:
 * a string or a missing model goes through DeepEval's provider selection). It replaces DeepEval's own
 * AnthropicModel, which sends no output format, ignores stop_reason and can send temperature 0.
 *
 * One user message (DeepEval's prompt); no system, temperature, top_p, top_k, thinking or fallbacks;
 * output_config.effort "low"; max_tokens 8192; with a schema, Claude structured output (the SDK's
 * zodOutputFormat: z.toJSONSchema minus constraints the API does not take). If the API rejects the
 * schema (400), it retries once without a format and parses the JSON out of the text. A refusal or a
 * cut-off throws, so the metric records an error, never a score. Spend counts even when a call throws.
 */

export class JudgeRefusalError extends Error {
  name = "JudgeRefusalError";
}
export class JudgeTruncatedError extends Error {
  name = "JudgeTruncatedError";
}

const { models } = await loadDeepEval();
const MAX_TOKENS = 8192;

const isSchemaRejection = (e: unknown) =>
  (e as { status?: number })?.status === 400 && /schema|output_config|format/i.test((e as Error).message ?? "");
const jsonIn = (text: string) => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

export class ClaudeJudge extends models.DeepEvalBaseLLM {
  readonly model: JudgeModel;
  readonly maxTokens: number;
  private readonly client?: JudgeClient<ClaudeRequest>;
  /** Read by E10's costs.json: requests sent, schema-rejection retries, refusals, cut-offs, total spend. */
  calls = 0;
  schemaRetries = 0;
  refusals = 0;
  truncations = 0;
  costUsd = 0;

  constructor(o: { model: JudgeModel; client?: JudgeClient<ClaudeRequest>; maxTokens?: number }) {
    super(o.model);
    this.model = o.model;
    this.client = o.client;
    this.maxTokens = o.maxTokens ?? MAX_TOKENS;
    this.temperature = null; // never sent; DeepEval's own providers read this
  }

  getModelName(): string {
    return this.model;
  }

  private async send(prompt: string, format?: ClaudeRequest["output_config"]["format"]): Promise<{ text: string; cost: number }> {
    this.calls++;
    const res: JudgeResponse = await (this.client ?? defaultJudgeClient()).messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      output_config: format ? { effort: "low", format } : { effort: "low" },
      messages: [{ role: "user", content: prompt }],
    });
    const u = res.usage;
    const cost = u
      ? costUsd(this.model, { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 })
      : 0;
    this.costUsd += cost;
    if (res.stop_reason === "refusal") {
      this.refusals++;
      throw new JudgeRefusalError(`${this.model} refused`);
    }
    if (res.stop_reason === "max_tokens" || res.stop_reason === "model_context_window_exceeded") {
      this.truncations++;
      throw new JudgeTruncatedError(`${this.model} stopped at ${res.stop_reason}`);
    }
    return { text: res.content.map((b) => (b.type === "text" ? b.text ?? "" : "")).join(""), cost };
  }

  async generate<T = string>(prompt: string, schema?: ZodType<T>): Promise<GenerationResult<T>> {
    if (!schema) {
      const { text, cost } = await this.send(prompt);
      return { output: text as T, cost };
    }
    const { type, schema: json } = zodOutputFormat(schema);
    try {
      const { text, cost } = await this.send(prompt, { type, schema: json });
      return { output: schema.parse(JSON.parse(text)), cost };
    } catch (e) {
      if (!isSchemaRejection(e)) throw e;
      this.schemaRetries++;
      const { text, cost } = await this.send(prompt);
      return { output: schema.parse(jsonIn(text)), cost };
    }
  }
}
