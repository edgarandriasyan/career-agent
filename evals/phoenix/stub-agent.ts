import type { AgentFn } from "../run";

// A free stub agent for wiring runs (`--agent stub`): one fixed sentence and a zero-cost done event.
// It never echoes the question, so private case text cannot reach its output.
const TEXT = "This is a stub reply.";

export function makeAgent(model: string, _o: { system?: string } = {}): AgentFn {
  return async function* (_c, o) {
    o?.onText?.(TEXT);
    yield { type: "sentence", text: TEXT, sources: [] };
    yield { type: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, model };
  };
}
