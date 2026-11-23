import { expect, test } from "vitest";
import type { AgentEvent } from "../../src/types";
import { truncatedReply } from "./truncated-reply";

const run = (reply: string, events: AgentEvent[] = []) =>
  truncatedReply({ c: { id: "x", category: "fit", question: "q" }, question: "q", reply, events, career: "", model: "m", latencyMs: { firstSentence: null, total: 0 } })[0];

test("truncated-reply passes the run A reply of fit-08 (Sonnet)", () => {
  const reply =
    "Edgar's most relevant match is Moonfare, where he was Senior Product Manager, AI from January 2025 to June 2026. He automated the regulated investor professionalisation journey (part of KYC and AML) for DACH, keeping a human in the loop, which let it ship into a regulated process despite imperfect model accuracy. He built it with n8n, AWS Bedrock and Claude Code, 10 to 15 times faster than a conventional non-AI delivery approach, and it saves about $250K a year. He also owned Moonfare's AI transformation and coordinated AI champions across departments. Gap to note: his AML exposure is seven months of communications ownership at a banking-as-a-service platform, which is adjacent to owning AML risk-control products, not the same thing. I can go deeper on any of these projects if useful.";
  expect(run(reply).pass).toBe(true);
});

test("truncated-reply fails the run A reply of fit-08 (Haiku)", () => {
  const reply =
    "Edgar's record matches the AI and regulated-operations side of this role. At Moonfare, Edgar was Senior Product Manager, AI from January 2025 to June 2026. His scope covered investment journeys, AI product development, regulated operations automation and cross-functional AI enablement. He owned Moonfare's AI transformation and coordinated AI champions across departments. On compliance, he automated Moonfare's regulated investor professionalisation journey (part of KYC and AML) for DACH, keeping a human in the loop for any decision that affects an investor record. That design choice is what let it ship into a regulated process despite imperfect model accuracy. The main gap is AML ownership.";
  expect(run(reply, [{ type: "fallback", reason: "truncated", detail: "max_tokens" }])).toMatchObject({ name: "truncated-reply", pass: false });
});

test("truncated-reply borderline: a reply whose last list item has no full stop passes when the model stopped normally (Edgar left run A Sonnet syn-facts-08 unnoted)", () => {
  expect(run("Образование: - BBA, American University of Armenia - AWS Certified Solutions Architect, Associate, срок действия истёк").pass).toBe(true);
});

test("truncated-reply leaves an end_turn with nothing shown to empty-reply", () => {
  expect(run("", [{ type: "fallback", reason: "truncated", detail: "empty" }]).pass).toBe(true);
});
