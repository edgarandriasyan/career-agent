import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentFn } from "../evals/run";
import { answer } from "./agent";

// The eval runner's real agent: answer() with a real client. Paid calls; get Edgar's approval
// first. The SDK reads ANTHROPIC_API_KEY itself; this file never reads or prints it. The client and
// files load on the first call, so building the agent (for example in a test) costs nothing.
// `system` overrides SYSTEM_PROMPT (ablation runs).
const CAREER = fileURLToPath(new URL("../corpus/career.md", import.meta.url));
const BLOCKLIST = fileURLToPath(new URL("../../private/blocklist.json", import.meta.url));

export function makeAgent(model: string, o: { system?: string } = {}): AgentFn {
  let deps: { client: Anthropic; career: string; blocklist: string[] } | undefined;
  return (c, x) => {
    deps ??= {
      client: new Anthropic(),
      career: readFileSync(CAREER, "utf8"),
      blocklist: JSON.parse(readFileSync(BLOCKLIST, "utf8")).terms,
    };
    const { client, career, blocklist } = deps;
    return answer(
      { career, history: c.history ?? [], question: c.question, model, blocklist, system: o.system },
      { client, onText: x?.onText },
    );
  };
}
