import Anthropic from "@anthropic-ai/sdk";
import { costUsd } from "../src/spend";
import { buildJudgeRequest, judgePromptHash, parseJudgeResponse, type ClaudeRequest, type JudgeRequest, type JudgeResponse } from "./judges/request";
import type { JudgeInput, JudgeModel, JudgeSpec, JudgeVerdict } from "./judges/spec";

/*
 * Node half of the judge runner: one paid call per verdict (get Edgar's cost approval first).
 * The request and parser live in judges/request.ts; this file sends the request and adds the cost.
 * The API key comes from the ANTHROPIC_API_KEY environment variable, read by the SDK; this file never
 * reads or prints it. Tests inject a fake client.
 */

/** The slice of the SDK that runJudge (and the DeepEval ClaudeJudge, with ClaudeRequest) uses, so tests can pass a fake. */
export type JudgeClient<R extends ClaudeRequest = JudgeRequest> = { messages: { create(params: R): Promise<JudgeResponse> } };

let realClient: JudgeClient<ClaudeRequest> | undefined;
/** The real SDK client, created on first use. No cast: tsc checks ClaudeRequest and JudgeResponse against the SDK. */
export const defaultJudgeClient = (): JudgeClient<ClaudeRequest> => {
  if (!realClient) {
    const c = new Anthropic();
    realClient = { messages: { create: (p) => c.messages.create(p) } };
  }
  return realClient;
};

export async function runJudge(
  spec: JudgeSpec,
  input: JudgeInput,
  deps: { client: JudgeClient; model: JudgeModel; corpus: string },
): Promise<JudgeVerdict> {
  const res = await deps.client.messages.create(buildJudgeRequest(spec, input, deps.model, deps.corpus));
  const u = res.usage;
  const spend = u
    ? costUsd(deps.model, {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      })
    : 0;
  return { ...parseJudgeResponse(res, spec, deps.model), promptHash: await judgePromptHash(spec), costUsd: spend };
}
