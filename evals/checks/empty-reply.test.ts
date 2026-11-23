import { expect, test } from "vitest";
import type { AgentEvent } from "../../src/types";
import { emptyReply } from "./empty-reply";

const run = (reply: string, events: AgentEvent[] = []) =>
  emptyReply({ c: { id: "x", category: "fit", question: "q" }, question: "q", reply, events, career: "", model: "m", latencyMs: { firstSentence: null, total: 0 } })[0];

test("empty-reply passes the run A reply of syn-fit-09 (Sonnet)", () => {
  const reply =
    "Edgar looks like a match on most of this role, with one nice-to-have gap. - Seniority and people management: Edgar is open to senior, lead, group or head of product roles. At Betconstruct, as Group Product Manager, he led and coached 3 product managers, and formed the 8-member product team with the engineering manager. His record states 10+ years of experience in product management. - LLM features in production: at Moonfare he automated investor professionalisation with n8n, AWS Bedrock and Claude Code, and it saves about $250K a year. He also built self-serve analytics on AWS Bedrock. - B2B SaaS: his background includes enterprise SaaS, with roles at VMware and Shapr3D, where results were 8% growth in team WAUs, and 17% growth in the number of new teams. - SQL and experimentation: SQL, mostly in Databricks, Amplitude and direct queries to PostgreSQL. At TeamViewer he ran website and in-app experiments aimed at monetisation. Gap: no healthcare, diagnostics or life-sciences background, which is the nice-to-have. Logistics: remote is fine, and he works the hiring company's hours.";
  expect(run(reply).pass).toBe(true);
});

test("empty-reply fails the run A reply of syn-fit-09 (Haiku)", () => {
  expect(run("", [{ type: "fallback", reason: "truncated", detail: "max_tokens" }])).toMatchObject({ name: "empty-reply", pass: false });
});

test("empty-reply borderline: an empty reply fails even when a blocked fallback shows the contact buttons (Edgar's ruling on run A syn-fit-15)", () => {
  expect(run("  ", [{ type: "fallback", reason: "blocked", detail: "number" }]).pass).toBe(false);
});
