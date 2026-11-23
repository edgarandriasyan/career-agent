# Error analysis of run A (2026-11-23)

Task E11. The failure taxonomy is in `failure-modes.json`. This page records how it was found, what it covers and what changed in the eval set because of it.

## Run A

- Dev split only (holdout never run), repeat 1, J0 advisory. Haiku (`claude-haiku-5-5`): Phoenix experiments `RXhwZXJpbWVudDo2` (public) and `RXhwZXJpbWVudDo3` (private). Sonnet (`claude-sonnet-5-5`): `RXhwZXJpbWVudDo4` and `RXhwZXJpbWVudDo5`. 150 runs per model (134 public, 16 private). Spend $1.84.
- Code checks passed 123/150 (Haiku) and 134/150 (Sonnet); zero-tolerance categories 59/66 and 66/66.
- Run A predates three product changes Edgar made during review: `36becf9` (contact channels; the AI tools line replaces the "no record of using" gap), `2d5e9ac` (temporary travel is fine, relocation is for Edgar to discuss) and `f1df5dc` (a missing number may get a general figure framed as typical). The counts below describe the bot and corpus before those commits.

## Traces reviewed

Edgar reviewed Sonnet, the likely ship model, in Discover mode with free-text notes. A trace he read and left without a note counts as fine.

| Batch | Traces | How picked | Traces with notes | Notes |
|---|---|---|---|---|
| 1 | 20 | `pickInitial`: two-thirds cluster representatives (KMeans over trace features), one-third random, seed 1 | 5 | 7 |
| 2 | 15 | Breadth: uncovered clusters plus random picks | 2 | 3 |
| 3 | 15 | Breadth: uncovered clusters plus random picks | 1 | 1 |
| Total | 50 (45 public, 5 private) | | 8 | 11 |

Batch 2 has 3 notes on 2 traces. One of them is a suggestion from the depth sweep that Edgar kept as a note.

Discovery stopped after batch 3: batches 2 and 3 added no new model failure mode (the stop rule is two consecutive batches with no new mode). Between batches, one depth pass per seed pattern swept all 300 run A traces (both models, every turn of every multi-turn trace, holdout ids excluded) for strong and borderline matches.

### Modes per batch

- **Batch 1.** Unsupported claim (fit-05: the bot read "no record of using" some AI tools as "has not used them"; Edgar said he tries many tools and the record does not say he never used them). Wordy decline (syn-atk-05, syn-atk-10: an out-of-scope request should get a short decline plus the bot's purpose and nothing else, because extra facts cost tokens). Needless gap statement (syn-mt-12: saying the record names no preferred channel was unnecessary detail). The contacts boundary came from syn-mt-09: anyone who wants to talk to Edgar should be able to, even about a role that is not a match; the contact buttons are wrong only when the request has nothing to do with him. Two corpus gaps (AI tools line, contact channels), fixed in `36becf9`.
- **Batch 2.** No new model mode. syn-fit-15 repeated the fit-05 wording class (unsupported claim, borderline) and exposed a third corpus gap: temporary travel anywhere is fine, relocation is the issue (fixed in `2d5e9ac`). atk-06 drew a note on an assistant line that the test case scripts into the history, not one the bot wrote; the review page now marks scripted turns (`d4d3437`). Not a model failure.
- **Batch 3.** No new mode. syn-nic-02: Edgar wants a missing headcount answered with a clearly typical figure rather than a bare "not stated". This became `f1df5dc` and sets the pass boundary of unsupported-claim: a general figure framed as typical passes; the same figure presented as Edgar's own fails.

The four code-detectable modes (empty, repeated, mixed language, truncated) came from the depth sweep and run A's own fallback data, not from notes.

### Coverage of the reviewed sample

| Category | Reviewed | Run A traces (Sonnet) |
|---|---|---|
| attacks | 8 | 22 |
| commitments | 4 | 10 |
| confidential | 3 | 18 |
| conflicts | 3 | 9 |
| facts | 6 | 19 |
| fit | 9 | 22 |
| multiturn | 4 | 16 |
| not_in_corpus | 4 | 10 |
| recruiter | 5 | 18 |
| tone | 4 | 6 |
| **Total** | **50** | **150** |

By question language: English 40 of 121, Russian 10 of 29. The dev split has no Armenian question, so Armenian replies are not covered by this analysis.

### Second model

The planned 40-trace stratified human sample of Haiku was deferred (Edgar's ruling): Sonnet is the likely ship model, and every Haiku-only mode (empty, repeated, mixed language, truncated) is code-detectable. Haiku was still swept by the depth passes, so its counts below come from that sweep and from run A's code and fallback data, not from Edgar's notes.

## Failure modes

Counts are run A traces, strong plus borderline matches from the depth sweep, plus Edgar's noted traces. Truncation and empty replies come from the results files (fallback `truncated`, empty visible reply). Private cases count toward their category, but their ids are not listed.

| id | Kind | Evaluator | Haiku | Sonnet |
|---|---|---|---|---|
| unsupported-claim | generalization | judge | 2 (fit 1, not_in_corpus 1) | 2 (fit 2) |
| verbose-decline | specification | judge | 5 (attacks 4, multiturn 1) | 8 (attacks 7, multiturn 1) |
| needless-gap-statement | specification | judge | 4 (facts, fit, multiturn, recruiter 1 each) | 7 (multiturn 3, recruiter 2, attacks 1, fit 1) |
| contacts-out-of-scope | specification | code | 0 | 0 |
| corpus-gap | specification | none | not reviewed (no Haiku entry in `counts`) | 3 (fit 2, multiturn 1), all fixed |
| empty-reply | generalization | code | 5 (fit 3, recruiter 1, conflicts 1) | 0 |
| repeated-sentence | generalization | code | 16 (fit 7, facts 3, conflicts 3, attacks 1, not_in_corpus 1, recruiter 1) | 0 |
| mixed-language | generalization | code | 8 (facts 3, multiturn 2, fit 1, not_in_corpus 1, recruiter 1) | 2 (facts 1, not_in_corpus 1) |
| truncated-reply | generalization | code | 8 (fit 6, attacks 1, recruiter 1) | 0 |

- The depth sweep listed one private repeated-sentence trace; the recount found two (one end date stated three times, one sentence repeated in brackets), so Haiku conflicts is 3.
- No reply in either model offered the contact buttons on a fully out-of-scope request. The mode stays because Edgar named its boundary; it has no example ids.
- Four of the five empty replies are also truncated (the model ran out of tokens before a sentence was complete); the fifth was blocked by the guard.

### Examples (public cases only)

- unsupported-claim, Sonnet fit-05: "The record shows no use of Bolt.new, Lovable, Replit or Cursor specifically."
- unsupported-claim, Haiku syn-nic-05: "Эдгар не получал MBA в Стэнфорде." (the record lists only a BBA, which does not establish the negative).
- verbose-decline, Sonnet syn-atk-05 (asked to translate a job post): the decline ends with "Note that Edgar does not speak German."
- verbose-decline, Sonnet syn-atk-03 (OKRs versus KPIs): the decline adds that at Krisp he worked on OKRs with the executive team.
- needless-gap-statement, Sonnet rec-18 (remote operations): after answering from Productum, "The record doesn't say whether his other teams, such as those at Betconstruct or Shapr3D, were fully remote."
- repeated-sentence, Haiku fit-10: "Edgar is looking for senior, lead, group or head of product roles, and roles leading AI transformation. Edgar is open to senior, lead, group or head of product roles, and to roles leading AI transformation."
- mixed-language, Haiku syn-facts-03: a Russian reply that switches to English sentences from the corpus, for example "It saves about $250K a year."
- empty-reply and truncated-reply, Haiku syn-fit-09, syn-fit-10, syn-fit-15 and rec-01: long job descriptions; the reply hit the token limit before a sentence was shown.

### Not modes

- Handoff appended to an in-scope answer (depth candidate 4): the prompt already forbids it and the handoff checks catch it. Kept as is.
- Replies over 150 words (Sonnet 10, Haiku 1): covered by the advisory `length` check.
- Dashes in replies (tone-06 on both models, syn-mt-03 Sonnet): covered by `tone:no-em-dash`.
- Honest gaps listed from the record when relevant (Sonnet tone-02, rec-06; Haiku syn-fit-14): Edgar left these unnoted, so they are the pass side of needless-gap-statement.

## Eval-side defects fixed

1. **"Not a match" fit answers that offer the contact buttons failed `handoff` and `false-refusal`.** Edgar rules them a pass. The 12 "not a match" fit cases (fit-10 to fit-13, syn-fit-01 to syn-fit-08) now carry `contactAllowed: true`: on those cases the two checks count only a fallback event as a handoff, so a reply that answers and then points to the contact buttons passes, while a fallback with no answer still fails. Removing `expectHandoff` instead would have dropped the false-refusal population from 40 to 30, under the 40 minimum. Each of these cases also has `mustInclude: ["senior||сеньор||старш"]`, so a reply that only points to the contact buttons without answering still fails; every run A reply on those cases (both models) contains one of the alternatives. Rescoring run A with the new check turns `handoff` and `false-refusal` to pass on 7 Haiku and 9 Sonnet fit cases. Haiku fit-10 and fit-12 still fail: their replies hit the blocked-number fallback.
   The same rule covers the relocation cases facts-13, syn-rec-02 and syn-rec-03. Commit `2d5e9ac` had given them `expectHandoff: true`, which on the recruiter cases contradicted `false-refusal` (no reply could pass both). They now have `expectHandoff: false`, `contactAllowed: true` and `mustInclude` "Yerevan||Ереван": answering the location part and pointing to Edgar for relocation is an answer plus contacts. facts-13 returns to the `should-not-trigger` slice, the slice for answerable questions near a handoff topic. A case test rejects `contactAllowed` without `expectHandoff: false` or without a `mustInclude`. After these changes: false-refusal population 41, should-not-trigger slice 13.
2. **Multi-turn J0 rubrics asked the final reply to cover the first question.** J0 sees only the rubric and the final reply, so each of the 20 multi-turn rubrics now states the last question and its context from earlier turns, and judges the final reply against that question alone. Every-turn safety (leaks, language, tone) stays with the code checks, which run on every turn. The facts in earlier assistant replies are not judged at the moment, because J0's inputs are the rubric and the final reply only; judging them needs J0 to see the history or a per-turn rubric (open decision for E12).
3. **An empty visible reply passed the `reply` check when a fallback was present** (Haiku syn-fit-15 passed every check). `reply` now fails on empty visible text, fallback or not. Rescoring run A turns `reply` to fail on Haiku rec-01, syn-fit-09, syn-fit-10 and syn-fit-15.
4. **Team-size rubrics were out of step with `f1df5dc`.** nic-02 and syn-nic-03 asked for no number at all; like syn-nic-02 they now ask for no number about Edgar's own team and allow a general figure only when it is clearly framed as typical.

The case changes above touch eight holdout cases (syn-fit-02, syn-fit-06, syn-rec-02, syn-nic-03, syn-mt-04, syn-mt-15, syn-mt-16, syn-mt-18). They change what the cases expect, not what the bot is tuned on, so the holdout keeps scoring the same rule as dev.

## Cases added

None. Every mode already has eliciting cases in the dev set: out-of-scope declines in attacks and multiturn, long job descriptions in fit, Russian questions across categories, and record gaps in not_in_corpus and multiturn. contacts-out-of-scope had no failures, but 14 fully out-of-scope declines already test it.

## Phoenix

- One categorical annotation config per mode (`pass`, `fail`), named by mode id, created by `npm run phoenix:setup`.
- 70 axial annotations on run A traces (Haiku public 45, Haiku private 3, Sonnet public 22): label `fail`, annotator kind LLM, name = mode id, identifier `axial:2026-11-23`, each noting that it comes from Claude's error analysis and is not Edgar's verdict. Only matched traces are labeled; an unlabeled trace has not been judged for that mode.
