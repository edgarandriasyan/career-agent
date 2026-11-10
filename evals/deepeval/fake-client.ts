import type { JudgeClient } from "../judge";
import type { ClaudeRequest, JudgeResponse } from "../judges/request";

/** Test helper: a fake Anthropic client that answers from `replies` in order (the last one repeats) and records each request. No network. */
export function fakeClient(replies: (Partial<JudgeResponse> | Error)[], seen: ClaudeRequest[] = []): JudgeClient<ClaudeRequest> {
  return {
    messages: {
      create: async (p) => {
        seen.push(JSON.parse(JSON.stringify(p)));
        const r = replies[Math.min(seen.length - 1, replies.length - 1)];
        if (r instanceof Error) throw r;
        return { stop_reason: "end_turn", content: [], ...r };
      },
    },
  };
}
export const text = (t: string) => [{ type: "text", text: t }];
