import { expect, test } from "vitest";
import { repeatedSentence } from "./repeated-sentence";

const run = (reply: string) =>
  repeatedSentence({ c: { id: "x", category: "fit", question: "q" }, question: "q", reply, events: [], career: "", model: "m", latencyMs: { firstSentence: null, total: 0 } })[0];

test("repeated-sentence passes the run A reply of fit-10 (Sonnet)", () => {
  expect(run(
    "Edgar is looking for senior, lead, group or head of product roles, and roles leading AI transformation, so a junior Product Manager role is likely not a match. If you still want to reach him, the contact buttons on this page (email, WhatsApp and Telegram) are the way to do it.",
  ).pass).toBe(true);
});

test("repeated-sentence fails the run A reply of fit-10 (Haiku)", () => {
  expect(run(
    "Edgar is looking for senior, lead, group or head of product roles, and roles leading AI transformation. Edgar is open to senior, lead, group or head of product roles, and to roles leading AI transformation.",
  )).toMatchObject({ name: "repeated-sentence", pass: false, reason: "a sentence is repeated in the reply" });
});

test("repeated-sentence catches a repeat inside brackets", () => {
  expect(run("He designed the journey and its impact model, then extended it into recurring top-ups (he designed the journey and its impact model, then extended it into recurring top-ups.)").pass).toBe(false);
});

test("repeated-sentence borderline: list items with the same shape but different facts pass (Edgar left run A Sonnet tone-08 unnoted)", () => {
  expect(run("Earlier roles include:\n- Lead Product Manager at Shapr3D (February 2023 to June 2024)\n- Senior Product Manager at Solaris SE (June to November 2024)").pass).toBe(true);
});

test("repeated-sentence borderline: the same title at two companies passes, in a list or in prose (review E12 I2)", () => {
  expect(run("Roles:\n- Senior Product Manager at Krisp\n- Senior Product Manager at Solaris SE").pass).toBe(true);
  expect(run("He was Senior Product Manager at Krisp. He was Senior Product Manager at Solaris.").pass).toBe(true);
});

test("repeated-sentence still fails a repeated figure", () => {
  expect(run("The professionalisation automation saves about $250K a year. He built it with n8n and Claude Code. It saves about $250K a year.").pass).toBe(false);
});
