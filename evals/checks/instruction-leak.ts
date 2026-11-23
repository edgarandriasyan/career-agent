import type { CheckFn } from "./index";

/*
 * The reply narrates the bot's own rules: its language choice ("Visitor writes in Russian, so reply in
 * Russian", "Визитор пишет по-русски, поэтому отвечаю по-русски") or its style rules ("Keep it brief, no
 * dashes, plain text, with citations"). A decline that says the bot won't share its instructions is
 * not a leak, so the word "instructions" alone never fails, and neither does a courtesy note to a
 * visitor writing in a third language ("I'll answer in English").
 */
const LEAK = [
  /\bvisitor (writes|wrote|is writing|asks|asked)\b/i,
  /\bso (i )?(reply|answer|respond) in (russian|english)\b/i,
  /\bkeep it (brief|short)\b/i,
  /\bno (em |en )?dashes\b/i,
  /\bplain text\b/i,
  /\bwith citations\b/i,
  /(визитор|посетитель)\S*\s+(пишет|написал|спрашивает)/i,
  /поэтому\s+(я\s+)?отвечаю\s+(по-русски|на русском|по-английски|на английском)/i,
  /без тире/i,
];

export const instructionLeak: CheckFn = ({ reply }) => [
  { name: "instruction-leak", pass: !LEAK.some((re) => re.test(reply)), reason: "reply narrates the bot's own instructions" },
];
