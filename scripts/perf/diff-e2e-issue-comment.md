<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

Draft for #8042 — do not post automatically.

Protocol v4 supersedes v3's stateless candidate warm endpoint with the product's
public resident-handle path. The fixtures, six rounds, resampling, admission and
idle rules stay unchanged.

The replacement uses six paired rounds with fixed seed 8042 and balanced
randomized order. It covers the demo revision pair, AC20-FZK-Haus and the
preserved large controlled IFC revision (head SHA256
f8e748cf1f2128609257c939aac9df40c6f62f70bbca6813ff5a67bb06ac853a), with one full
timed public-call configuration (all three configurations remain in untimed
identity proofs). That gives six primary endpoints and 72 timing
children. Cold lifecycle includes initialization and fingerprint construction;
candidate warm prepares two public `prepareDiffModel` handles once, conditions
one `base.compare(head, options)` and times repeated compares. Preparation and
disposal stay in lifecycle reporting, outside call latency. The TS arm retains
v3's JS rows plus repeated `diffModels`. Each result records the detected API
and executed path; a candidate without the public handle API is rejected.
Stateless candidate `diffModels` warm medians are reported separately after
handle disposal and never enter the gates. Warm repeats run within one process.

Cold lifecycle keeps the paired ratio gate: upper 95% CI at most 1.10.
Warm handle latency uses the candidate's absolute per-process medians: upper
95% CI at most **1 ms demo, 1 ms Haus, 50 ms large**. These premeasurement
budgets are recorded in `protocol.acceptance.warmBudgetMs`. Both gates use
10,000 percentile bootstrap resamples and seed 8042. Cold resamples pairs;
warm resamples candidate process medians. Warm ratio versus TS and stateless
candidate warm medians are reported, never gated.

Regression means any cold lower CI above 1.10 or warm lower CI above budget.
Pass requires every cold upper CI at most 1.10, every warm upper CI at most its
budget, and no noise; otherwise inconclusive. Spread over 20% is flagged noisy
(both cold arms, candidate only for warm). No familywise speedup claim. Full output hashes,
Map/optional-field structure and original-reference identity remain a separate
hard gate. Standard exclusive idle admission remains mandatory; per-round CPU
and load samples are descriptive, without classifying every host process.

Before posting, insert the v4 small-fixture proof receipt and exact source pins.
A one-pair ordinary smoke is functional evidence only, with no performance
verdict. The parent schedules the single official v4 cohort separately.

Fresh source-pinned preparation and v4 binding/admission records are required;
the old frozen protocol approval does not apply. The measured verdict and
lesson must be recorded in scripts/perf/README.md before consumer cutover.
Separate correctness and geometry-enriched coverage obligations remain open.
