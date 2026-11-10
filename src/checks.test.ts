import { expect, test } from "vitest";
import { checkSentence, corpusNumbers, extractNumbers } from "./checks";

const ctx = { blocklist: ["secretterm", "two words"], numbers: corpusNumbers("Raised $1.1M, 400+ and 25% in 2024.") };

test("blocklist any case", () => expect(checkSentence("A SecretTerm here", ctx).ok).toBe(false));
test("blocklist across spaces", () => expect(checkSentence("two   words", ctx).ok).toBe(false));
test("known numbers pass", () => expect(checkSentence("It raised $1.1M, about 25%.", ctx).ok).toBe(true));
test("unknown number fails", () => expect(checkSentence("It saved $999k.", ctx)).toMatchObject({ ok: false, reason: "number" }));
test("comma decimal normalizes", () => expect(checkSentence("Итог 1,1 млн.", ctx).ok).toBe(true));
test("list marker ignored", () => expect(checkSentence("1. It raised $1.1M.", ctx).ok).toBe(true));
test("no numbers passes", () => expect(checkSentence("He led the team.", ctx).ok).toBe(true));

test("blocklist detail does not leak the term", () => {
  const r = checkSentence("A secretterm here", ctx);
  expect(r).toMatchObject({ ok: false, reason: "blocklist" });
  expect(JSON.stringify(r)).not.toContain("secretterm");
});
test("number detail names the number", () =>
  expect(checkSentence("It saved $999k.", ctx)).toEqual({ ok: false, reason: "number", detail: "999000" }));
test("blocklist works for Cyrillic in any case", () => {
  const c = { ...ctx, blocklist: ["секрет"] };
  expect(checkSentence("Это СЕКРЕТ.", c).ok).toBe(false);
  expect(checkSentence("Это тайна.", c).ok).toBe(true);
});
test("bare-digit blocklist term needs digit boundaries", () => {
  const c = { blocklist: ["12"], numbers: new Set(["2012", "120", "12"]) };
  expect(checkSentence("In 2012 it grew.", c).ok).toBe(true);
  expect(checkSentence("About 120 people.", c).ok).toBe(true);
  expect(checkSentence("About 12 people.", c).ok).toBe(false);
  expect(checkSentence("Team of 12.", c).ok).toBe(false);
});
test("word term still matches inside a longer word", () =>
  expect(checkSentence("supersecrettermish", ctx).ok).toBe(false));
test("blank blocklist entries are ignored", () =>
  expect(checkSentence("Hello.", { ...ctx, blocklist: ["", "  "] }).ok).toBe(true));
test("years must be in the corpus", () => {
  expect(checkSentence("In 2024 it grew.", ctx).ok).toBe(true);
  expect(checkSentence("In 2019 it grew.", ctx)).toMatchObject({ ok: false, reason: "number" });
});

test("extractNumbers normalises", () => {
  expect(extractNumbers("$1.1M")).toEqual(["1100000"]);
  expect(extractNumbers("1,1 млн")).toEqual(["1100000"]);
  expect(extractNumbers("1,000 and 1 000 and 1,000,000")).toEqual(["1000", "1000", "1000000"]);
  expect(extractNumbers("400+ and 25% and 3 тыс")).toEqual(["400", "25", "3000"]);
  expect(extractNumbers("2.50 and 2.0 and 05")).toEqual(["2.5", "2", "5"]);
  expect(extractNumbers("in 2024. Then")).toEqual(["2024"]);
  expect(extractNumbers("1. First item")).toEqual([]);
  expect(extractNumbers("2024 100 people")).toEqual(["2024", "100"]);
  expect(extractNumbers("2019-2021")).toEqual(["2019", "2021"]);
});
test("corpusNumbers ignores list markers on every line", () =>
  expect([...corpusNumbers("1. Alpha 7\n2. Beta")]).toEqual(["7"]));

test("magnitude suffixes are part of the value", () => {
  const c = { blocklist: [], numbers: corpusNumbers("Raised $250K and 400+ users, $1.1M.") };
  expect(checkSentence("It raised $250M.", c)).toMatchObject({ ok: false, reason: "number" });
  expect(checkSentence("It raised $250K.", c).ok).toBe(true);
  expect(checkSentence("400k users.", c)).toMatchObject({ ok: false, reason: "number" });
  expect(checkSentence("400+ users.", c).ok).toBe(true);
  expect(checkSentence("It raised 1.1 million.", c).ok).toBe(true);
  expect(checkSentence("Итог 1,1 млн.", c).ok).toBe(true);
  expect(checkSentence("It raised $1.1B.", c)).toMatchObject({ ok: false, reason: "number" });
  expect(extractNumbers("2 млрд, 3 bn, 4 billion, 5 тыс, 8 months")).toEqual(["2000000000", "3000000000", "4000000000", "5000", "8"]);
});
test("URLs are not numbers, on either side", () => {
  const c = { blocklist: [], numbers: corpusNumbers("Over 10 years. See https://x.com/watch?v=abc12&index=5 now.") };
  expect(checkSentence("Over 12 years.", c)).toMatchObject({ ok: false, reason: "number" });
  expect(checkSentence("Over 5 years.", c)).toMatchObject({ ok: false, reason: "number" });
  expect(checkSentence("See https://x.com/watch?v=zzz99 for more.", c).ok).toBe(true);
});
test("digits directly after a letter are identifiers, not numbers", () => {
  expect(extractNumbers("B2B, S3, Q1 and B212")).toEqual([]);
  expect(extractNumbers("mid-2019 and Q1 2024")).toEqual(["2019", "2024"]);
});
test("blocklist ignores zero-width characters and width variants", () => {
  expect(checkSentence("A secret\u200bterm here", ctx).ok).toBe(false);
  expect(checkSentence("A ｓｅｃｒｅｔｔｅｒｍ here", ctx).ok).toBe(false);
});
