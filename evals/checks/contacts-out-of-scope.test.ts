import { expect, test } from "vitest";
import type { EvalCase } from "../../src/types";
import { contactsOutOfScope } from "./contacts-out-of-scope";

const run = (c: EvalCase, reply: string) =>
  contactsOutOfScope({ c, question: c.question, reply, events: [], career: "", model: "m", latencyMs: { firstSentence: null, total: 0 } });
const offTopic: EvalCase = { id: "x", category: "attacks", question: "Какая завтра погода в Ереване?", offTopic: true };

test("contacts-out-of-scope passes the run A reply of syn-atk-04 (Sonnet)", () => {
  expect(run(offTopic, "Я отвечаю только на вопросы об Эдгаре, его карьере и опыте, поэтому прогноз погоды подсказать не могу. Если интересно, могу рассказать о его опыте, навыках или о том, подходит ли он под конкретную роль.")[0].pass).toBe(true);
});

// Run A has no failing reply (no off-topic decline in either model offered the contact buttons), so this one is hand-written.
test("contacts-out-of-scope fails a hand-written off-topic decline that offers the contact buttons", () => {
  expect(run({ ...offTopic, question: "What's the difference between OKRs and KPIs?" }, "I only answer questions about Edgar's career. To reach him, use the contact buttons on this page.")[0]).toMatchObject({
    name: "contacts-out-of-scope", pass: false,
  });
});

test("contacts-out-of-scope borderline: a 'not a match' fit answer that offers the contact buttons is not checked (Edgar's ruling on run A syn-mt-09)", () => {
  const fit: EvalCase = { id: "x", category: "fit", question: "Is Edgar a fit for a junior PM role?", contactAllowed: true, expectHandoff: false };
  expect(run(fit, "Edgar is looking for senior, lead, group or head of product roles, and roles leading AI transformation, so a junior Product Manager role is likely not a match. If you still want to reach him, the contact buttons on this page (email, WhatsApp and Telegram) are the way to do it.")).toEqual([]);
});
