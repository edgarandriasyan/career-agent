import type { CheckFn } from "./index";

/*
 * The same sentence stated twice in one reply. Sentences, list lines and bracketed parts are compared
 * as sets of words; two parts of at least MIN_WORDS distinct words count as the same when they share
 * at least half of all their words (Jaccard) and the shorter one is mostly inside the longer one
 * (containment), unless each part names something the other does not: a capitalised word after the
 * first, or a word with a digit ("Senior Product Manager at Krisp" and "... at Solaris SE" are two
 * facts, not one). Run A [Claude's call, tuned on run A]: every Haiku hit is a near-verbatim repeat
 * and Sonnet has none; looser paraphrases ("the same fact" in other words) are left to review.
 */
const MIN_WORDS = 5;
const JACCARD = 0.5;
const CONTAINMENT = 0.8;

type Part = { words: Set<string>; names: Set<string> };

const parts = (reply: string): Part[] =>
  reply
    .split(/(?<=[.!?])\s+|\n+|\s*[()]\s*/)
    .map((s) => {
      const tokens = s.match(/[\p{L}\p{N}]+/gu) ?? [];
      const names = tokens.filter((t, i) => (i > 0 && /^\p{Lu}/u.test(t)) || /\p{N}/u.test(t)).map((t) => t.toLowerCase());
      return { words: new Set(tokens.map((t) => t.toLowerCase())), names: new Set(names) };
    })
    .filter((p) => p.words.size >= MIN_WORDS);

const namesOther = (a: Part, b: Part) => [...a.names].some((n) => !b.words.has(n));

const same = (a: Part, b: Part) => {
  const shared = [...a.words].filter((w) => b.words.has(w)).length;
  return (
    shared / (a.words.size + b.words.size - shared) >= JACCARD &&
    shared / Math.min(a.words.size, b.words.size) >= CONTAINMENT &&
    !(namesOther(a, b) && namesOther(b, a))
  );
};

export const repeatedSentence: CheckFn = ({ reply }) => {
  const ps = parts(reply);
  const repeated = ps.some((a, i) => ps.slice(i + 1).some((b) => same(a, b)));
  return [{ name: "repeated-sentence", pass: !repeated, reason: "a sentence is repeated in the reply" }];
};
