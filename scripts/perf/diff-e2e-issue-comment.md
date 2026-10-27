<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

Draft for #8042 — do not post automatically.

The frozen 25-pair performance protocol is superseded by diff-e2e protocol v3.
The old protocol required 1,200 timing children across 24 endpoints, Holm24
sign tests, a synthetic 750k-row expansion and periodic whole-host process
classification. Its estimated 13–17 hours on Pop was disproportionate to the
issue's end-to-end comparison requirement and the fleet minimum of five pairs.

The replacement uses six paired rounds with fixed seed 8042 and balanced
randomized order. It covers the demo revision pair, AC20-FZK-Haus and the
preserved large controlled IFC revision (head SHA256
f8e748cf1f2128609257c939aac9df40c6f62f70bbca6813ff5a67bb06ac853a), with one full
public-call configuration. That gives six primary endpoints and 72 timing
children. Cold lifecycle includes initialization and fingerprint construction;
warm public calls retain inputs and include marshaling, comparison, result
restoration and per-call handle release. Warm repeats run within one process.

Each endpoint reports its median paired ratio and pointwise 95% paired bootstrap
CI. A clean pass requires every upper bound at most 1.10; a lower bound above
1.10 supports regression; a crossing interval is inconclusive. Spread over 20%
is flagged noisy. This makes no familywise speedup claim. Full output hashes,
Map/optional-field structure and original-reference identity remain a separate
hard gate. Standard exclusive idle admission remains mandatory; per-round CPU
and load samples are descriptive, without classifying every host process.

A one-pair small-fixture ordinary smoke is required before scheduling the full
cohort. Its receipt, per-pair cost and explicit scale assumption must accompany
the full-run estimate. No full cohort is authorized by the smoke, and no timing
verdict has been claimed. The measured verdict and lesson must be recorded in
scripts/perf/README.md before consumer cutover. Separate correctness and
geometry-enriched coverage obligations remain open.
