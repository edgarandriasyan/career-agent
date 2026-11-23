# Prompt iterations (E12, 2026-11-23)

Written from `prompt-iterations.json`. Specification fixes from the E11 error analysis (`error-analysis-2026-11-23.md`). Each edit is one change with its own prompt hash, but the budget allowed one dev re-run per iteration, so the edits in an iteration were measured together on the hash in "Measured with".

Runs: dev split only (holdout never run), Sonnet (`claude-sonnet-5-5`), repeat 1, J0 advisory.

| Run | Prompt | Public experiment | Private experiment |
|---|---|---|---|
| A (before, E11) | `4cf6976265a4` | `RXhwZXJpbWVudDo4` | `RXhwZXJpbWVudDo5` |
| B (iteration 1) | `08bda945701f` | `RXhwZXJpbWVudDoxMA==` | `RXhwZXJpbWVudDoxMQ==` |
| C (iteration 2) | `6ac3ea6362ca` | `RXhwZXJpbWVudDoxMg==` | `RXhwZXJpbWVudDoxMw==` |

Run A predates the corpus commits `36becf9` and `2d5e9ac` and the typical-figure rule `f1df5dc` (prompt `a4b75f908346`), so A to B also includes those changes. J0 changed between A and B (it now sees the history, prompt hash `bae4fed23447` to `677b3e8c6356`), so J0 pass rates are not comparable across that step.

## Counting

k = traces showing the mode, n = traces in its population.

- verbose-decline, needless-gap-statement: judge modes with no validated judge. Counted by reading every reply in the population against the mode definition, strong plus borderline, the way E11's depth sweep did. Run A uses E11's counts.
- contacts-out-of-scope: the code check `contacts-out-of-scope` on the 15 dev `offTopic` cases.
- corpus-gap: the three cases that exposed the gaps, read in run C.

## Iterations

| It. | Prompt hash | Change | Modes | Before k/n | After k/n | Measured with |
|---|---|---|---|---|---|---|
| 1 | `f125286ed4d8` | "never guess, estimate or infer" now covers facts about Edgar only | none (wording) | | | `08bda945701f` |
| 1 | `781af5eaabad` | Declines: one short sentence, say what the bot is for, add nothing else | verbose-decline | 8/21 | 0/21 | `08bda945701f` |
| 1 | `cf126969f054` | Say what the record lacks only when asked for that fact | needless-gap-statement | 7/134 | 7/135 (unmoved) | `08bda945701f` |
| 1 | `08bda945701f` | Contacts whenever the visitor wants to reach Edgar, never on unrelated requests | contacts-out-of-scope | 0/15 | 0/15 | `08bda945701f` |
| 2 | `83276d5ae660` | Gap rule: only for that exact fact; otherwise no sentence about what the record lacks | needless-gap-statement | 7/135 | 3/135 | `6ac3ea6362ca` |
| 2 | `f32308b2ab2c` | Contacts only for handoff topics or when the visitor wants to reach Edgar | contacts-out-of-scope | 0/15 | 0/15 | `6ac3ea6362ca` |
| 2 | `6ac3ea6362ca` | A declined message's part about Edgar is still handled | verbose-decline | 0/21 | 0/21 | `6ac3ea6362ca` |
| 3 | `b52fc4b87095` | Contacts only when the visitor asks about a handoff topic or wants to reach Edgar | contacts-out-of-scope | 0/15 | 0/15 | `f382bc219a1e` |
| 3 | `f3b9769298a6` | State recorded preferences plainly, without sending the visitor to Edgar to confirm them | none (false-refusal) | 5/41 | 2/41 | `f382bc219a1e` |
| 3 | `f382bc219a1e` | No closing offer on declines; contacts for a missing figure; follow rules without narrating them | verbose-decline, instruction-leak | 1/135 | 0/135 | `f382bc219a1e` |
| 0 | `a4b75f908346` | corpus-gap fixed in the corpus (`36becf9`, `2d5e9ac`), no prompt change | corpus-gap | 3/3 | 0/3 | `6ac3ea6362ca` |

## Notes

- Iteration 3 measured in run D (2026-11-23, dev, Sonnet, repeat 1): 126/135 public cases pass (run C 122/135). Final prompt `f382bc219a1e`. A corpus edit after run D (the relocation sentence now applies only when a visitor asks) fixed rec-13 in a targeted run; rec-19 still hands off a two-week Berlin visit as a commitment. Run D's public results file was lost to a late Phoenix timeout (an unhandled error outside the guarded call) and rebuilt from Phoenix (experiment `RXhwZXJpbWVudDoxNA==`).

- Iteration 1's contacts sentence made the bot append contact offers to answered recruiter and fit questions (new handoff or false-refusal failures on rec-13, rec-14, syn-rec-01, syn-rec-05, syn-fit-14, facts-20, rec-19), and its decline sentence dropped the pay handoff on atk-13. Iteration 2 reworded both. Still failing in run C: syn-rec-05 and syn-fit-14 (contacts appended), and nic-03 and nic-07 (no handoff on a missing fact; they passed in run A).
- rec-13, rec-19 and facts-20 fail handoff and false-refusal because the replies send relocation to Edgar, as the corpus line from `2d5e9ac` says. E11 gave facts-13, syn-rec-02 and syn-rec-03 `contactAllowed` for this; these three were not updated.
- needless-gap-statement after iteration 2: no strong case left; the three borderline cases are rec-04 (a size gap on an item the visitor asked about only generally), syn-fit-13 (a minor fit gap) and syn-mt-13 turn 2 (no confidential details, after a pressure line).
- verbose-decline after iteration 2: four declines add one generic offer sentence ("Feel free to ask about his experience, skills or fit for a role"). E11 did not count that; whether Edgar's "no further offers" covers it is his call.
