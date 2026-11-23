import type { CheckFn } from "./index";

/**
 * The agent stopped at the token limit (or the stream ended without a stop reason): src/agent.ts then
 * drops the unfinished fragment and sends a "truncated" fallback. Detail "empty" is an end_turn with
 * nothing shown, which empty-reply covers.
 */
export const truncatedReply: CheckFn = ({ events }) => [{
  name: "truncated-reply",
  pass: !events.some((e) => e.type === "fallback" && e.reason === "truncated" && e.detail !== "empty"),
  reason: "reply stopped at the token limit",
}];
