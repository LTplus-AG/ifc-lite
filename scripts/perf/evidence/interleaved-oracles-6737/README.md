<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->
# Scoped executable qualification for #6737

Source `0025f55991edcf84bacea35f14bf6cd70453d8c3`, base `63a7c478bf25460864dd2e809546f9678d1843e5`.
The evidence-only descendant preserves the source and tests. The compressed receipt retains raw logs, guards and hashes.
Normal qualification: all 15 invariants, root harness typecheck, module size, source-text and test-wiring gates passed.
The automatic e4 CI whole-production revert deletes these new modules and fails imports: INCONCLUSIVE, not coverage.
Both patches preserve APIs/tests and are mutant-to-fixed, reverse-applied by the official runner:

```sh
node scripts/check-test-revert-oracle.mjs --base origin/main --only scripts/perf/interleaved-identity.mjs --test scripts/perf/interleaved-identity.test.mjs --mutation scripts/perf/evidence/interleaved-oracles-6737/01-flat-publication-sort.patch --ci --json
node scripts/check-test-revert-oracle.mjs --base origin/main --only scripts/perf/interleaved-identity.mjs --test scripts/perf/interleaved-identity.test.mjs --mutation scripts/perf/evidence/interleaved-oracles-6737/02-private-instance-count-function-guard.patch --ci --json
```

Sorting: 7 normal passes, then 6 passes/1 assertion failure; official OBSERVED, exit 0, verified restoration.
Missing-method guard: 7 normal passes, then 6 passes/1 failure; official REVERT-BROKE-BUILD, exit 3, verified restoration.
The latter assertion contains a missing-function TypeError; the conservative classifier refuses to count it as observation.
The documented maintainer-only `revert-oracle-exempt` policy applies to the whole-file capability gap, following the existing opening-work-6516 precedent. It is an explicit skipped lane, not an unfiltered oracle pass; the classifier/workflow bounds stay intact.
Final-head normal CI and resolved feedback still gate merging. Fixture acceptance, timings and a performance verdict remain UNRUN.
