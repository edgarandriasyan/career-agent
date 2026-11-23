import type { AgentEvent, CaseResult, CheckResult, EvalCase } from "../../src/types";
import { contactsOutOfScope } from "./contacts-out-of-scope";
import { emptyReply } from "./empty-reply";
import { handedOff } from "./handoff";
import { instructionLeak } from "./instruction-leak";
import { mixedLanguage, wantsRussian } from "./mixed-language";
import { repeatedSentence } from "./repeated-sentence";
import { truncatedReply } from "./truncated-reply";

export { handedOff, pointsToEdgar } from "./handoff";

/*
 * Code checks: one registry. scoreDeterministic (score.ts) runs every entry. The failure-mode checks
 * from E12 live in their own files, named by mode id (failure-modes.json).
 *
 * Check names and reasons never contain case text (terms, questions, replies, URLs), so results
 * from private cases can be logged safely. A failed check says which list and which position failed.
 * A check's family is its name up to "#" (checkFamily); validation/status.json is keyed by family,
 * and every family here must be listed there as "code".
 *
 * mustInclude entries may list alternatives separated by "||" (for example "nov||ноябр" so one
 * case works for English and Russian replies). Matching is a case-insensitive substring match.
 *
 * Handoff rule: see handoff.ts. On contactAllowed cases only the fallback event counts (handoffFor),
 * so an answer that also offers the contact buttons passes.
 */

export type CheckInput = {
  c: EvalCase;
  question: string;
  reply: string;
  events: AgentEvent[];
  career: string;
  model: string;
  latencyMs: CaseResult["latencyMs"];
};
export type CheckFn = (i: CheckInput) => CheckResult[];

export const checkFamily = (name: string): string => name.split("#")[0];

/**
 * Multi-turn cases run every check on every turn. These families read the last turn only (the case's
 * expectations); every other family fails the case when any turn fails it.
 */
export const LAST_TURN_ONLY = ["mustInclude", "handoff", "false-refusal", "contacts-out-of-scope", "length", "traj:citations", "traj:latency"];

/** Per-turn agent cost ceilings in USD [Claude's call]; revise from costs.json after E10. */
export const COST_CEILING: Record<string, number> = { "claude-haiku-5-5": 0.002, "claude-sonnet-5-5": 0.02 };
export const MAX_WORDS = 180;
export const MAX_FIRST_SENTENCE_MS = 5000;

const handoffFor = (c: EvalCase, reply: string, events: AgentEvent[]): boolean =>
  c.contactAllowed ? events.some((e) => e.type === "fallback") : handedOff(reply, events);

const EMOJI = /\p{Extended_Pictographic}/u;
const NOT_EMOJI = /[©®™]/g; // copyright, registered, trademark signs
const URL_RE = /https?:\/\/[^\s<>()"']+/g;

const includes = (text: string, entry: string) => entry.split("||").some((alt) => text.includes(alt.trim().toLowerCase()));

/** Letter count and the Latin and Cyrillic shares of letters. */
function scripts(s: string) {
  const count = (re: RegExp) => s.match(re)?.length ?? 0;
  const letters = count(/\p{L}/gu);
  return {
    letters,
    latin: letters ? count(/\p{Script=Latin}/gu) / letters : 0,
    cyrillic: letters ? count(/\p{Script=Cyrillic}/gu) / letters : 0,
  };
}

export const CODE_CHECKS: Record<string, CheckFn> = {
  "empty-reply": emptyReply,
  mustInclude: ({ c, reply }) =>
    (c.mustInclude ?? []).map((s, i) => ({ name: `mustInclude#${i + 1}`, pass: includes(reply.toLowerCase(), s), reason: "required text missing" })),
  mustNotInclude: ({ c, reply }) =>
    (c.mustNotInclude ?? []).map((s, i) => ({ name: `mustNotInclude#${i + 1}`, pass: !includes(reply.toLowerCase(), s), reason: "forbidden text present" })),
  handoff: ({ c, reply, events }) =>
    c.expectHandoff === undefined
      ? []
      : [{
          name: "handoff",
          pass: handoffFor(c, reply, events) === c.expectHandoff,
          reason: c.expectHandoff ? "no handoff to Edgar or contact buttons" : "unexpected handoff",
        }],
  "tone:no-em-dash": ({ reply }) => [{ name: "tone:no-em-dash", pass: !reply.includes("—"), reason: "reply contains an em dash" }],
  "tone:no-emoji": ({ reply }) => [{ name: "tone:no-emoji", pass: !EMOJI.test(reply.replace(NOT_EMOJI, "")), reason: "reply contains an emoji" }],
  /** False-refusal population: recruiter cases and expectHandoff:false cases. */
  "false-refusal": ({ c, reply, events }) =>
    c.category === "recruiter" || c.expectHandoff === false
      ? [{ name: "false-refusal", pass: !handoffFor(c, reply, events), reason: "handed off or fell back on an answerable question" }]
      : [],
  /**
   * A question with any Cyrillic word (and no Armenian letter) needs a Russian reply; any other
   * question an English one. No letters in the reply: nothing to check.
   */
  lang: ({ question, reply }) => {
    const r = scripts(reply);
    const wantRu = wantsRussian(question);
    const pass = r.letters === 0 || (wantRu ? r.cyrillic >= 0.5 : r.latin >= 0.8);
    return [{ name: "lang", pass, reason: wantRu ? "reply is not in Russian" : "reply is not in English" }];
  },
  links: ({ reply, career }) => {
    const urls = (reply.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
    return [{ name: "links", pass: urls.every((u) => career.includes(u)), reason: "reply has a link that is not in career.md" }];
  },
  "plain-text": ({ reply, events }) => {
    const text = [reply, ...events.flatMap((e) => (e.type === "sentence" ? [e.text] : []))].join("\n");
    const pass = !/^\s*#/m.test(text) && !text.includes("**") && !/^\s*\|/m.test(text) && !text.includes("!");
    return [{ name: "plain-text", pass, reason: "reply has a heading, bold, table row or exclamation mark" }];
  },
  length: ({ reply }) => [
    { name: "length", pass: reply.split(/\s+/).filter(Boolean).length <= MAX_WORDS, reason: `reply over ${MAX_WORDS} words`, advisory: true },
  ],
  "repeated-sentence": repeatedSentence,
  "mixed-language": mixedLanguage,
  "truncated-reply": truncatedReply,
  "contacts-out-of-scope": contactsOutOfScope,
  "instruction-leak": instructionLeak,
  "traj:citations": ({ c, events }) =>
    ["facts", "fit", "conflicts"].includes(c.category)
      ? [{
          name: "traj:citations",
          pass: events.some((e) => e.type === "sentence" && e.sources.length > 0),
          reason: "no sentence with sources",
          advisory: true,
        }]
      : [],
  "traj:cost": ({ model, events }) => {
    const ceiling = COST_CEILING[model];
    if (ceiling === undefined) return [];
    const cost = events.reduce((s, e) => s + (e.type === "done" ? e.costUsd : 0), 0);
    return [{ name: "traj:cost", pass: cost <= ceiling, reason: `turn cost over $${ceiling}`, advisory: true }];
  },
  "traj:latency": ({ latencyMs }) => [{
    name: "traj:latency",
    pass: latencyMs.firstSentence === null || latencyMs.firstSentence <= MAX_FIRST_SENTENCE_MS,
    reason: `first sentence after ${MAX_FIRST_SENTENCE_MS / 1000} s`,
    advisory: true,
  }],
};
