import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentFn } from "../evals/run";
import { answer } from "./agent";

// The eval runner's default agent: answer() with a real client. Paid calls; get Edgar's approval
// first. The SDK reads ANTHROPIC_API_KEY itself; this file never reads or prints it.
const CAREER = fileURLToPath(new URL("../corpus/career.md", import.meta.url));
const BLOCKLIST = fileURLToPath(new URL("../../private/blocklist.json", import.meta.url));

export function makeAgent(model: string): AgentFn {
  const client = new Anthropic();
  const career = readFileSync(CAREER, "utf8");
  const blocklist: string[] = JSON.parse(readFileSync(BLOCKLIST, "utf8")).terms;
  return (c) => answer({ career, history: c.history ?? [], question: c.question, model, blocklist }, { client });
}
