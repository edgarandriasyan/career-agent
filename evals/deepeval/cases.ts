import type { LLMTestCase } from "deepeval";
import { EMPTY_REPLY } from "../judges/request";
import type { CaseRun, LoadedCase } from "../run";
import { loadDeepEval } from "./env";

/*
 * One case run as a DeepEval LLMTestCase: the visitor's question, the reply (what the visitor saw, or
 * the raw model text before the sentence filter), `context` = career.md split on "## ", and
 * `retrievalContext` = the "## " sections the reply cited (a "###" source maps to its "## " section).
 * As in E3's judge: an uncited reply is checked against the whole corpus, and an empty reply (the
 * visitor saw the static contact message) is E3's placeholder text, so both get a verdict, not an error.
 * The result holds case text and replies: never write it under public/ for a private case.
 */

const de = await loadDeepEval();

const sections = (career: string) => career.split(/^## /m).map((s) => s.trim()).filter(Boolean);
const headings = (section: string) => [section.split("\n")[0].trim(), ...[...section.matchAll(/^#{3,6}\s+(.+)$/gm)].map((m) => m[1].trim())];

export function toTestCase(run: CaseRun, _c: LoadedCase, career: string, text: "visible" | "raw"): LLMTestCase {
  const context = sections(career);
  const cited = new Set(run.result.events.flatMap((e) => (e.type === "sentence" ? e.sources : [])));
  const retrieved = context.filter((s) => headings(s).some((h) => cited.has(h)));
  return new de.LLMTestCase({
    input: run.question,
    actualOutput: (text === "raw" ? run.rawText : run.result.reply) || EMPTY_REPLY,
    context,
    retrievalContext: retrieved.length ? retrieved : context,
  });
}
