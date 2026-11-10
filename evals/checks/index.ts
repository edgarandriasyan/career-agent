import type { AgentEvent, CaseResult, CheckResult, EvalCase } from "../../src/types";

/*
 * Code checks: one registry. scoreDeterministic (score.ts) runs every entry; E12 adds entries.
 *
 * Check names and reasons never contain case text (terms, questions, replies, URLs), so results
 * from private cases can be logged safely. A failed check says which list and which position failed.
 * A check's family is its name up to "#" (checkFamily); validation/status.json is keyed by family,
 * and every family here must be listed there as "code".
 *
 * mustInclude entries may list alternatives separated by "||" (for example "nov||ноябр" so one
 * case works for English and Russian replies). Matching is a case-insensitive substring match.
 *
 * Handoff rule: a reply hands off when the agent sent a fallback event (the page shows the contact
 * buttons) or the reply text sends the visitor to Edgar or the contact buttons (HANDOFF below).
 * A bare mention of "contact" in another sense does not count.
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
export const LAST_TURN_ONLY = ["mustInclude", "handoff", "false-refusal", "length", "traj:citations", "traj:latency"];

/** Per-turn agent cost ceilings in USD [Claude's call]; revise from costs.json after E10. */
export const COST_CEILING: Record<string, number> = { "claude-haiku-5-5": 0.002, "claude-sonnet-5-5": 0.02 };
export const MAX_WORDS = 180;
export const MAX_FIRST_SENTENCE_MS = 5000;

const HANDOFF = new RegExp(
  [
    String.raw`ask (edgar|him)`,
    String.raw`(contact|reach|message|email|write to) (out to )?(edgar|him)`,
    String.raw`contact (buttons?|options)`,
    String.raw`get in touch`,
    String.raw`(talk|speak) (to|with) edgar`,
    String.raw`edgar directly`,
    String.raw`directly (with|to) edgar`,
    String.raw`gmail|whatsapp|telegram`,
    "спросит\\S*\\s+(у\\s+)?эдгар",
    "свяж\\S*",
    "напиш\\S*\\s+эдгар",
    "кнопк\\S*\\s+(контакт|связ)",
    "контактн\\S*\\s+кнопк",
    "напрямую\\s+(у|к|с)\\s+эдгар|эдгар\\S*\\s+напрямую",
  ].join("|"),
  "i",
);

export const handedOff = (reply: string, events: AgentEvent[]): boolean =>
  events.some((e) => e.type === "fallback") || HANDOFF.test(reply);

const EMOJI = /\p{Extended_Pictographic}/u;
const NOT_EMOJI = /[©®™]/g; // copyright, registered, trademark signs
const URL_RE = /https?:\/\/[^\s<>()"']+/g;

const includes = (text: string, entry: string) => entry.split("||").some((alt) => text.includes(alt.trim().toLowerCase()));

/** Letter count, Latin and Cyrillic shares of letters, and the number of Armenian letters. */
function scripts(s: string) {
  const count = (re: RegExp) => s.match(re)?.length ?? 0;
  const letters = count(/\p{L}/gu);
  return {
    letters,
    latin: letters ? count(/\p{Script=Latin}/gu) / letters : 0,
    cyrillic: letters ? count(/\p{Script=Cyrillic}/gu) / letters : 0,
    armenian: count(/\p{Script=Armenian}/gu),
  };
}

export const CODE_CHECKS: Record<string, CheckFn> = {
  reply: ({ reply, events }) => [
    { name: "reply", pass: events.some((e) => e.type === "fallback") || reply.trim() !== "", reason: "no reply and no fallback" },
  ],
  mustInclude: ({ c, reply }) =>
    (c.mustInclude ?? []).map((s, i) => ({ name: `mustInclude#${i + 1}`, pass: includes(reply.toLowerCase(), s), reason: "required text missing" })),
  mustNotInclude: ({ c, reply }) =>
    (c.mustNotInclude ?? []).map((s, i) => ({ name: `mustNotInclude#${i + 1}`, pass: !includes(reply.toLowerCase(), s), reason: "forbidden text present" })),
  handoff: ({ c, reply, events }) =>
    c.expectHandoff === undefined
      ? []
      : [{
          name: "handoff",
          pass: handedOff(reply, events) === c.expectHandoff,
          reason: c.expectHandoff ? "no handoff to Edgar or contact buttons" : "unexpected handoff",
        }],
  "tone:no-em-dash": ({ reply }) => [{ name: "tone:no-em-dash", pass: !reply.includes("—"), reason: "reply contains an em dash" }],
  "tone:no-emoji": ({ reply }) => [{ name: "tone:no-emoji", pass: !EMOJI.test(reply.replace(NOT_EMOJI, "")), reason: "reply contains an emoji" }],
  /** False-refusal population: recruiter cases and expectHandoff:false cases. */
  "false-refusal": ({ c, reply, events }) =>
    c.category === "recruiter" || c.expectHandoff === false
      ? [{ name: "false-refusal", pass: !handedOff(reply, events), reason: "handed off or fell back on an answerable question" }]
      : [],
  /**
   * A question with any Cyrillic word (and no Armenian letter) needs a Russian reply; any other
   * question an English one. No letters in the reply: nothing to check.
   */
  lang: ({ question, reply }) => {
    const q = scripts(question);
    const r = scripts(reply);
    const wantRu = q.armenian === 0 && /\p{Script=Cyrillic}{2,}/u.test(question);
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
