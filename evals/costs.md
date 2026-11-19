# Measured eval costs

Pilot of 2026-11-19 (E10): 5 public dev cases, every component on the models below. Generated from `costs.json` by `evals/pilot.ts costs`; do not edit by hand. Costs in USD from `src/spend.ts` rates.

## Per component

| Component | Model | Calls | Per call | Per case | Cache read share | Errors | Refusals | Schema retries |
|---|---|---|---|---|---|---|---|---|
| bot (answer) | claude-haiku-5-5 | 7 | $0.00038 | $0.00053 | 99.5% | 0 | 0 | 0 |
| bot (answer) | claude-sonnet-5-5 | 7 | $0.00479 | $0.00670 | 99.5% | 0 | 0 | 0 |
| J0 judge | claude-sonnet-5-5 | 5 | $0.00474 | $0.00474 | 97.7% | 0 | 0 | 0 |
| J0 judge | claude-opus-5-5 | 5 | $0.02015 | $0.02015 | 78.1% | 0 | 0 | 0 |
| DeepEval TS (scoreDeepEval) | claude-haiku-5-5 | 28 | $0.00032 | $0.00179 | 0.0% | 0 | 0 | 0 |
| DeepEval TS (scoreDeepEval) | claude-sonnet-5-5 | 28 | $0.00525 | $0.02940 | 0.0% | 0 | 0 | 0 |
| DeepEval Py classifier | claude-haiku-5-5 | 5 | $0.00015 | $0.00015 | 0.0% | 0 | 0 | 0 |
| DeepEval Py classifier | claude-sonnet-5-5 | 5 | $0.00270 | $0.00270 | 0.0% | 0 | 0 | 0 |
| phoenix-evals Faithfulness | claude-haiku-5-5 | 5 | $0.00118 | $0.00118 | 0.0% | 0 | 0 | 0 |
| phoenix-evals Faithfulness | claude-sonnet-5-5 | 5 | $0.02350 | $0.02350 | 0.0% | 0 | 0 | 0 |
| phoenix-evals Refusal | claude-haiku-5-5 | 4 | $0.00016 | $0.00016 | 0.0% | 0 | 0 | 0 |
| phoenix-evals Refusal | claude-sonnet-5-5 | 4 | $0.00299 | $0.00299 | 0.0% | 0 | 0 | 0 |
| DeepEval Py Synthesizer (2 goldens) | claude-haiku-5-5 | 33 | $0.00026 | $0.00850 | 0.0% | 1 | 0 | 0 |
| DeepEval Py Synthesizer (2 goldens) | claude-sonnet-5-5 | 18 | $0.00468 | $0.08417 | 0.0% | 0 | 0 | 0 |
| DeepEval Py ConversationSimulator (1 conversation) | claude-haiku-5-5 | 4 | $0.00022 | $0.00088 | 0.0% | 0 | 0 | 0 |
| DeepEval Py ConversationSimulator (1 conversation) | claude-sonnet-5-5 | 4 | $0.00380 | $0.01522 | 0.0% | 0 | 0 | 0 |
| bot (simulated turn) | claude-haiku-5-5 | 2 | $0.00154 | $0.00308 | 0.0% | 0 | 0 | 0 |
| bot (simulated turn) | claude-sonnet-5-5 | 2 | $0.02775 | $0.05549 | 0.0% | 0 | 0 | 0 |

## Standing caps (Proposed, awaiting Edgar's approval)

`BUDGETS` in `budgets.ts` keeps the current caps until Edgar approves. Proposed cap = estimate x 1.5, rounded up to a quarter-dollar; caps cover the bot and its judges.

| Model | PR subset: current | PR subset: proposed (estimate) | Full run, 3 repeats: current | Full run: proposed (estimate) |
|---|---|---|---|---|
| `claude-haiku-5-5` | $0.50 | $0.75 ($0.42) | $3.00 | $4.25 ($2.69) |
| `claude-sonnet-5-5` | $1.50 | $1.50 ($0.91) | $6.00 | $8.50 ($5.53) |

- PR subset, haiku bot: 110 x bot (answer) haiku per call ($0.00038) + 80 x J0 judge sonnet per call ($0.00474) = $0.42
- PR subset, sonnet bot: 110 x bot (answer) sonnet per call ($0.00479) + 80 x J0 judge sonnet per call ($0.00474) = $0.91
- Full run, haiku bot: 645 x bot (answer) haiku per call ($0.00038) + 516 x J0 judge sonnet per call ($0.00474) = $2.69
- Full run, sonnet bot: 645 x bot (answer) sonnet per call ($0.00479) + 516 x J0 judge sonnet per call ($0.00474) = $5.53

## Phase budgets from E11 on (Proposed, awaiting Edgar's approval)

Lean: Haiku wherever validated, Sonnet judge development. Recommended: Opus judge development, Sonnet baselines and Synthesizer, Haiku elsewhere. Ceiling: Sonnet everywhere and Opus judge development. Each range is [estimate, estimate x 1.5]; the totals are the sums of the rows. For the Synthesizer and simulator components, "per case" is per run (2 goldens, 1 conversation).

| Phase | Item | Lean | Recommended | All-Sonnet ceiling |
|---|---|---|---|---|
| C | Bot, run A, dev split, both models (about 200 calls each) | $1.03 to 1.55 | $1.03 to 1.55 | $1.03 to 1.55 |
| C | J0 advisory judge (Sonnet) on rubric cases, both runs (about 260 verdicts) | $1.23 to 1.85 | $1.23 to 1.85 | $1.23 to 1.85 |
| C | Re-runs after specification fixes, 2 x dev split incl. J0 (Haiku bot; ceiling Sonnet bot) | $1.38 to 2.07 | $1.38 to 2.07 | $3.15 to 4.72 |
| D | Ablation runs, 3 sections x about 100 cases, no judge (Haiku; ceiling Sonnet) | $0.11 to 0.17 | $0.11 to 0.17 | $1.44 to 2.16 |
| D | Judge development, 4 to 5 judges, about 1,100 calls (lean Sonnet; recommended and ceiling Opus) | $5.21 to 7.82 | $22.16 to 33.24 | $22.16 to 33.24 |
| D | Cheaper-model measurement on frozen test splits (Haiku and Sonnet judges, about 200 each) | $0.99 to 1.49 | $0.99 to 1.49 | $0.99 to 1.49 |
| D | DeepEval TS baselines on test splits, about 200 case-metrics (about 510 calls; lean Haiku, else Sonnet) | $0.16 to 0.24 | $2.68 to 4.02 | $2.68 to 4.02 |
| D | DeepEval Python classifiers on test splits, about 250 calls (lean Haiku, else Sonnet) | $0.04 to 0.06 | $0.68 to 1.01 | $0.68 to 1.01 |
| D | phoenix-evals Faithfulness and Refusal, about 40 calls each (lean Haiku, else Sonnet) | $0.05 to 0.08 | $1.06 to 1.59 | $1.06 to 1.59 |
| E | DeepEval Synthesizer, about 100 goldens (lean Haiku, else Sonnet) | $0.42 to 0.64 | $4.21 to 6.31 | $4.21 to 6.31 |
| E | ConversationSimulator, 30 conversations of 6 user turns: 2 simulator calls per turn, the bot's turns and about 13 conversational-metric calls each (Haiku; ceiling Sonnet) | $0.27 to 0.41 | $0.27 to 0.41 | $4.28 to 6.42 |
| F | Launch gate run: both models once on the full set (about 260 calls) plus 3 repeats on the chosen model (Haiku; ceiling Sonnet) | $1.64 to 2.46 | $1.64 to 2.46 | $5.08 to 7.62 |
| F | Validated judges inside the gate run, about 1,000 verdicts (Haiku; ceiling Sonnet) | $0.24 to 0.36 | $0.24 to 0.36 | $4.74 to 7.11 |
| G | RAG bot calls, 3 arms x about 160 cases x 3 repeats (Haiku; ceiling Sonnet) | $0.54 to 0.82 | $0.54 to 0.82 | $6.90 to 10.34 |
| G | J1 on RAG arms, about 1,440 verdicts (Haiku; ceiling Sonnet) | $0.34 to 0.51 | $0.34 to 0.51 | $6.82 to 10.23 |
| G | DeepEval contextual metrics, about 10 calls per case: Haiku on both retrieval arms (320 cases), Sonnet check on 40 cases (ceiling Sonnet on both arms) | $3.12 to 4.68 | $3.12 to 4.68 | $18.90 to 28.35 |
| E21 | J1 re-validation on about 100 labeled production traces (lean Haiku, else Sonnet) | $0.02 to 0.04 | $0.47 to 0.71 | $0.47 to 0.71 |
| Total | | $16.79 to 25.25 | $42.15 to 63.25 | $85.82 to 128.72 |

### Per-row arithmetic (estimate)

- C, Bot, run A, dev split, both models (about 200 calls each):
  - lean: 200 x bot (answer) haiku per call ($0.00038) + 200 x bot (answer) sonnet per call ($0.00479) = $1.03
  - recommended: 200 x bot (answer) haiku per call ($0.00038) + 200 x bot (answer) sonnet per call ($0.00479) = $1.03
  - ceiling: 200 x bot (answer) haiku per call ($0.00038) + 200 x bot (answer) sonnet per call ($0.00479) = $1.03
- C, J0 advisory judge (Sonnet) on rubric cases, both runs (about 260 verdicts):
  - lean: 260 x J0 judge sonnet per call ($0.00474) = $1.23
  - recommended: 260 x J0 judge sonnet per call ($0.00474) = $1.23
  - ceiling: 260 x J0 judge sonnet per call ($0.00474) = $1.23
- C, Re-runs after specification fixes, 2 x dev split incl. J0 (Haiku bot; ceiling Sonnet bot):
  - lean: 400 x bot (answer) haiku per call ($0.00038) + 260 x J0 judge sonnet per call ($0.00474) = $1.38
  - recommended: 400 x bot (answer) haiku per call ($0.00038) + 260 x J0 judge sonnet per call ($0.00474) = $1.38
  - ceiling: 400 x bot (answer) sonnet per call ($0.00479) + 260 x J0 judge sonnet per call ($0.00474) = $3.15
- D, Ablation runs, 3 sections x about 100 cases, no judge (Haiku; ceiling Sonnet):
  - lean: 300 x bot (answer) haiku per call ($0.00038) = $0.11
  - recommended: 300 x bot (answer) haiku per call ($0.00038) = $0.11
  - ceiling: 300 x bot (answer) sonnet per call ($0.00479) = $1.44
- D, Judge development, 4 to 5 judges, about 1,100 calls (lean Sonnet; recommended and ceiling Opus):
  - lean: 1100 x J0 judge sonnet per call ($0.00474) = $5.21
  - recommended: 1100 x J0 judge opus per call ($0.02015) = $22.16
  - ceiling: 1100 x J0 judge opus per call ($0.02015) = $22.16
- D, Cheaper-model measurement on frozen test splits (Haiku and Sonnet judges, about 200 each):
  - lean: 200 x J0 judge sonnet per call x 0.05 ($0.00024) + 200 x J0 judge sonnet per call ($0.00474) = $0.99
  - recommended: 200 x J0 judge sonnet per call x 0.05 ($0.00024) + 200 x J0 judge sonnet per call ($0.00474) = $0.99
  - ceiling: 200 x J0 judge sonnet per call x 0.05 ($0.00024) + 200 x J0 judge sonnet per call ($0.00474) = $0.99
- D, DeepEval TS baselines on test splits, about 200 case-metrics (about 510 calls; lean Haiku, else Sonnet):
  - lean: 510 x DeepEval TS (scoreDeepEval) haiku per call ($0.00032) = $0.16
  - recommended: 510 x DeepEval TS (scoreDeepEval) sonnet per call ($0.00525) = $2.68
  - ceiling: 510 x DeepEval TS (scoreDeepEval) sonnet per call ($0.00525) = $2.68
- D, DeepEval Python classifiers on test splits, about 250 calls (lean Haiku, else Sonnet):
  - lean: 250 x DeepEval Py classifier haiku per call ($0.00015) = $0.04
  - recommended: 250 x DeepEval Py classifier sonnet per call ($0.00270) = $0.68
  - ceiling: 250 x DeepEval Py classifier sonnet per call ($0.00270) = $0.68
- D, phoenix-evals Faithfulness and Refusal, about 40 calls each (lean Haiku, else Sonnet):
  - lean: 40 x phoenix-evals Faithfulness haiku per call ($0.00118) + 40 x phoenix-evals Refusal haiku per call ($0.00016) = $0.05
  - recommended: 40 x phoenix-evals Faithfulness sonnet per call ($0.02350) + 40 x phoenix-evals Refusal sonnet per call ($0.00299) = $1.06
  - ceiling: 40 x phoenix-evals Faithfulness sonnet per call ($0.02350) + 40 x phoenix-evals Refusal sonnet per call ($0.00299) = $1.06
- E, DeepEval Synthesizer, about 100 goldens (lean Haiku, else Sonnet):
  - lean: 100 x DeepEval Py Synthesizer (2 goldens) haiku per case x 0.5 ($0.00425) = $0.42
  - recommended: 100 x DeepEval Py Synthesizer (2 goldens) sonnet per case x 0.5 ($0.04208) = $4.21
  - ceiling: 100 x DeepEval Py Synthesizer (2 goldens) sonnet per case x 0.5 ($0.04208) = $4.21
- E, ConversationSimulator, 30 conversations of 6 user turns: 2 simulator calls per turn, the bot's turns and about 13 conversational-metric calls each (Haiku; ceiling Sonnet):
  - lean: 360 x DeepEval Py ConversationSimulator (1 conversation) haiku per call ($0.00022) + 180 x bot (answer) haiku per call ($0.00038) + 390 x DeepEval TS (scoreDeepEval) haiku per call ($0.00032) = $0.27
  - recommended: 360 x DeepEval Py ConversationSimulator (1 conversation) haiku per call ($0.00022) + 180 x bot (answer) haiku per call ($0.00038) + 390 x DeepEval TS (scoreDeepEval) haiku per call ($0.00032) = $0.27
  - ceiling: 360 x DeepEval Py ConversationSimulator (1 conversation) sonnet per call ($0.00380) + 180 x bot (answer) sonnet per call ($0.00479) + 390 x DeepEval TS (scoreDeepEval) sonnet per call ($0.00525) = $4.28
- F, Launch gate run: both models once on the full set (about 260 calls) plus 3 repeats on the chosen model (Haiku; ceiling Sonnet):
  - lean: 1040 x bot (answer) haiku per call ($0.00038) + 260 x bot (answer) sonnet per call ($0.00479) = $1.64
  - recommended: 1040 x bot (answer) haiku per call ($0.00038) + 260 x bot (answer) sonnet per call ($0.00479) = $1.64
  - ceiling: 260 x bot (answer) haiku per call ($0.00038) + 1040 x bot (answer) sonnet per call ($0.00479) = $5.08
- F, Validated judges inside the gate run, about 1,000 verdicts (Haiku; ceiling Sonnet):
  - lean: 1000 x J0 judge sonnet per call x 0.05 ($0.00024) = $0.24
  - recommended: 1000 x J0 judge sonnet per call x 0.05 ($0.00024) = $0.24
  - ceiling: 1000 x J0 judge sonnet per call ($0.00474) = $4.74
- G, RAG bot calls, 3 arms x about 160 cases x 3 repeats (Haiku; ceiling Sonnet):
  - lean: 1440 x bot (answer) haiku per call ($0.00038) = $0.54
  - recommended: 1440 x bot (answer) haiku per call ($0.00038) = $0.54
  - ceiling: 1440 x bot (answer) sonnet per call ($0.00479) = $6.90
- G, J1 on RAG arms, about 1,440 verdicts (Haiku; ceiling Sonnet):
  - lean: 1440 x J0 judge sonnet per call x 0.05 ($0.00024) = $0.34
  - recommended: 1440 x J0 judge sonnet per call x 0.05 ($0.00024) = $0.34
  - ceiling: 1440 x J0 judge sonnet per call ($0.00474) = $6.82
- G, DeepEval contextual metrics, about 10 calls per case: Haiku on both retrieval arms (320 cases), Sonnet check on 40 cases (ceiling Sonnet on both arms):
  - lean: 3200 x DeepEval TS (scoreDeepEval) haiku per call ($0.00032) + 400 x DeepEval TS (scoreDeepEval) sonnet per call ($0.00525) = $3.12
  - recommended: 3200 x DeepEval TS (scoreDeepEval) haiku per call ($0.00032) + 400 x DeepEval TS (scoreDeepEval) sonnet per call ($0.00525) = $3.12
  - ceiling: 3600 x DeepEval TS (scoreDeepEval) sonnet per call ($0.00525) = $18.90
- E21, J1 re-validation on about 100 labeled production traces (lean Haiku, else Sonnet):
  - lean: 100 x J0 judge sonnet per call x 0.05 ($0.00024) = $0.02
  - recommended: 100 x J0 judge sonnet per call ($0.00474) = $0.47
  - ceiling: 100 x J0 judge sonnet per call ($0.00474) = $0.47

## Notes

- Every phase row, total and proposed cap is computed by `evals/pilot.ts costs` from the per-row terms (volume x a measured component's average cost per call or per case); the per-row arithmetic is listed above. Volumes are planning figures from the eval-program plan.
- Haiku judge costs are estimates: J0 was not run on Haiku, so a Haiku verdict is priced as the measured Sonnet J0 call x 0.05 (the price ratio). Judge development is priced the same way for Sonnet and Opus: the measured average J0 call, cold cache write included (Sonnet $0.00474, Opus $0.0201; warm Opus alone is about $0.0096, so the Opus row is an upper estimate if sessions stay warm).
- Prompt caching works as designed: the bot read 99.5% of its input from cache, the J0 judge 97.7% on Sonnet and 78.1% on Opus (one cache write in five calls). The first call after five idle minutes writes the cache: about $0.002 on Haiku, $0.04 on Sonnet and $0.08 on Opus for the bot or judge prefix (about 16,200 tokens).
- DeepEval (TS and Python) and phoenix-evals send no cache markers, so every corpus-carrying call pays full input price: Faithfulness against career.md costs about $0.02 to 0.035 per case on Sonnet, 20 times the Haiku figure.
- Synthesizer per golden: Sonnet about $0.042. The Haiku run failed with an IndexError in DeepEval 4.3.3's synchronous generate_goldens_from_contexts (it does not cap the inputs a model returns to max_goldens_per_context, then indexes its progress bars past the end); its per-golden figure (about $0.004) comes from the calls made before the failure. The simulated conversation stopped after 2 user turns (expected outcome reached).
- "bot (simulated turn)" has no token counts (bot-cli.ts returns only its cost), so its cache read share shows 0%; each conversation's first turn wrote the cache, which is why its per-call cost is above the bot's warm figure.
- Pilot verdicts on the multi-turn case are invalid for the DeepEval Python classifier and phoenix-evals (Faithfulness, Refusal) and for DeepEval TS: the scorers paired the first question with the last turn's reply (a bug, since fixed with a shared last-turn view). Its costs are unaffected.
- Phoenix's own cost for the two pilot experiments was within 11% of spend.ts (Haiku bot run with Sonnet J0: $0.0455 vs $0.0509; Sonnet: $0.0570 vs $0.0570). No reply was blocked in the pilot, so the blocked-reply under-count was not exercised.
