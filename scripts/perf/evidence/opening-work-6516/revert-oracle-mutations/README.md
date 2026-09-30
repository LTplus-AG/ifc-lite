<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Executable mutation qualification for #6536

The automatic whole-file revert on source head
`0bdbfbbf7d4ca58ecf424fe9e84daed97dabbe86` removes the new private kernel
helper while the changed tests still import it. Its compilation failure is
INCONCLUSIVE; no failing assertion from that run qualifies the change. A
changed census TSV also has no executable Rust target attribution. These
are the documented oracle capability limits, not passing tests.

The three adjacent patches remove only behavioral decisions while preserving
all APIs, feature flags and tests. They are written mutant-to-fixed so the
official runner reverse-applies them. Run sequentially in a clean throwaway
checkout; the runner restores and verifies the original source after each.

```sh
node scripts/check-test-revert-oracle.mjs --base origin/main \
  --only rust/geometry/src/csg/group_cut.rs \
  --test rust/geometry/src/router/voids/batch_miss_tests.rs \
  --mutation scripts/perf/evidence/opening-work-6516/revert-oracle-mutations/miss-reuse.patch --ci --json
node scripts/check-test-revert-oracle.mjs --base origin/main \
  --only rust/geometry/src/router/voids/batch_cutter.rs \
  --test rust/geometry/src/router/voids/batch_miss_tests.rs \
  --mutation scripts/perf/evidence/opening-work-6516/revert-oracle-mutations/operand-identity.patch --ci --json
node scripts/check-test-revert-oracle.mjs --base origin/main \
  --only rust/geometry/src/csg/group_cut.rs \
  --test rust/geometry/src/router/voids/batch_miss_tests.rs \
  --mutation scripts/perf/evidence/opening-work-6516/revert-oracle-mutations/same-count-fallback.patch --ci --json
```

Each real baseline ran seven passing tests. Each mutation produced genuine
assertion failures, an OBSERVED verdict and verified restoration. The
miss-reuse run reports five passes and three failures across eight parsed
results because its isolated child failure is also reported by the parent
harness; it does not establish three distinct newly failing test functions.
The operand-identity and same-count mutations each produced six passes and
one assertion failure. The raw JSON preserves the exact test identities,
source head, base, feature invocation, timestamps and invocation IDs.

This is scoped evidence for the changed algorithm and its safety decisions,
not an unfiltered CI oracle pass, an end-to-end benchmark, or proof that the
reporter's unavailable private model is fixed. The repository's existing
maintainer-only `revert-oracle-exempt` policy supports legitimate refactors
whose whole-file revert removes their test interface. If used, that skipped
CI lane remains an explicit exemption; the full normal source suites,
independent geometry qualification and performance verdict remain necessary.
