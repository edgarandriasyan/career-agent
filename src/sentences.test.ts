import { expect, test } from "vitest";
import { SentenceSegmenter } from "./sentences";

const seg = (...p: string[]) => { const s = new SentenceSegmenter(); return [...p.flatMap(x => s.push(x)), ...s.flush()]; };

test("splits across chunks", () => expect(seg("Hello the", "re. Next one.")).toEqual(["Hello there.", "Next one."]));
test("keeps decimals", () => expect(seg("It raised $1.1M. Then more.")).toEqual(["It raised $1.1M.", "Then more."]));
test("keeps abbreviations", () => expect(seg("Compare vs. others, e.g. this. Done.")).toEqual(["Compare vs. others, e.g. this.", "Done."]));
test("Russian", () => expect(seg("Это было в 2024 г. в Берлине. Да.")).toEqual(["Это было в 2024 г. в Берлине.", "Да."]));
test("Russian decimal", () => expect(seg("Итог 1,1 млн. Да.")).toEqual(["Итог 1,1 млн.", "Да."]));
test("flushes without punctuation", () => expect(seg("No full stop")).toEqual(["No full stop"]));
test("list items split on newline", () => expect(seg("- one\n- two\n")).toEqual(["- one", "- two"]));

test("waits for the next chunk before deciding on a final period", () => {
  const s = new SentenceSegmenter();
  expect(s.push("It raised $1.")).toEqual([]);
  expect(s.push("1M. Done.")).toEqual(["It raised $1.1M."]);
  expect(s.flush()).toEqual(["Done."]);
});
test("numbered list marker is not a sentence end", () => expect(seg("1. First item\n2. Second item\n")).toEqual(["1. First item", "2. Second item"]));
test("question and exclamation marks end sentences", () => expect(seg("Really? Yes! Ok.")).toEqual(["Really?", "Yes!", "Ok."]));
test("closing quote stays with its sentence", () => expect(seg('He said "go." Then left.')).toEqual(['He said "go."', "Then left."]));
test("flush resets", () => {
  const s = new SentenceSegmenter();
  s.push("one");
  expect(s.flush()).toEqual(["one"]);
  expect(s.flush()).toEqual([]);
});
test("markdown emphasis closers stay with their sentence", () => expect(seg("**Bold.** Next one.")).toEqual(["**Bold.**", "Next one."]));
