// Number rule: a number is the digit run in the text, normalised to a plain
// string. URLs are removed first, and a digit run directly after a letter or
// digit is part of an identifier (B2B, S3, Q1), not a number. Currency symbols,
// sign, % and + are ignored. A magnitude suffix is folded into the value
// (k/тыс, m/mn/million/млн, b/bn/billion/млрд), so "$1.1M", "1,1 млн" and
// "1.1 million" are all 1100000 and "$250M" is not "$250K". A comma followed by
// exactly three digits is a thousands separator ("1,000" -> "1000"; so is
// "1 000" and "1.000.000"); any other comma is a decimal comma ("1,1" -> "1.1").
// Leading zeros and trailing decimal zeros go ("05" -> "5", "2.50" -> "2.5").
// A leading list marker ("1. ") is ignored. Years are numbers like any other.

const SCALES: [RegExp, number][] = [
  [/^(?:k|тыс)(?!\p{L})/iu, 1e3],
  [/^(?:m|mn|million|млн)(?!\p{L})/iu, 1e6],
  [/^(?:b|bn|billion|млрд)(?!\p{L})/iu, 1e9],
];

export function extractNumbers(text: string): string[] {
  const t = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, "")
    .replace(/(?<![\d.,])\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?!\d)/g, m => m.replace(/[ \u00a0\u202f]/g, ""));
  const out: string[] = [];
  for (const m of t.matchAll(/(?<![\p{L}\d])\d+(?:[.,]\d+)*/gu)) {
    const n = normalise(m[0]);
    const rest = t.slice(m.index + m[0].length).replace(/^\s?/, "");
    const scale = SCALES.find(([re]) => re.test(rest))?.[1];
    out.push(scale ? String(Math.round(parseFloat(n) * scale)) : n);
  }
  return out;
}

function normalise(t: string): string {
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  else if (/^\d{1,3}(?:\.\d{3}){2,}(?:,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, ".");
  t = t.replace(/^0+(?=\d)/, "");
  return t.includes(".") ? t.replace(/\.?0+$/, "") : t;
}

export function corpusNumbers(career: string): Set<string> {
  return new Set(extractNumbers(career));
}

// A term matches case-insensitively, with any whitespace run between words.
// A term that starts or ends with a digit also needs a non-digit on that side,
// so "12" does not match inside "2012" or "120".
const clean = (s: string) => s.normalize("NFKC").replace(/[\u200b-\u200f\u2060\ufeff]/g, "");
const patterns = new Map<string, RegExp>();
function termPattern(term: string): RegExp {
  let re = patterns.get(term);
  if (!re) {
    const body = clean(term.trim()).split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const before = /^\d/.test(body) ? "(?<!\\d)" : "";
    const after = /\d$/.test(body) ? "(?!\\d)" : "";
    re = new RegExp(before + body + after, "iu");
    patterns.set(term, re);
  }
  return re;
}

export type SentenceCheck = { ok: true } | { ok: false; reason: "blocklist" | "number"; detail: string };

export function checkSentence(s: string, ctx: { blocklist: string[]; numbers: Set<string> }): SentenceCheck {
  for (const [i, term] of ctx.blocklist.entries()) {
    // The detail is logged, so it never carries the term itself.
    if (term.trim() && termPattern(term).test(clean(s))) return { ok: false, reason: "blocklist", detail: `blocklist term #${i}` };
  }
  for (const n of extractNumbers(s)) {
    if (!ctx.numbers.has(n)) return { ok: false, reason: "number", detail: n };
  }
  return { ok: true };
}
