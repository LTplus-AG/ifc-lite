<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# #6679 foundation surgical mutation evidence

Source checkout: `/tmp/ifc6679-oracle-foundation`, detached `7e1bfc76dd5a153054291e70997a878f42e8d49b`.
The patches are mutant-to-fixed; the official runner reverse-applies each one.
All tests, schemas and module APIs remain intact. This qualifies two behavioral
safety decisions; it does not turn the automatic whole-file revert into a pass.

Run each command sequentially from the checkout:

```sh
node scripts/check-test-revert-oracle.mjs --base origin/main --only apps/viewer/src/lib/storage/content-library.ts --test apps/viewer/src/lib/storage/content-controller.test.ts --mutation docs/architecture/evidence/6679-user-content/mutations/dirty-revision.patch --ci --json
node scripts/check-test-revert-oracle.mjs --base origin/main --only apps/viewer/src/lib/storage/content-library.ts --test apps/viewer/src/lib/storage/content-controller.test.ts --mutation docs/architecture/evidence/6679-user-content/mutations/restore-edit-generation.patch --ci --json
```

Each official run returned exit 0, a baseline of 2 passes, and an attributable
mutated run of 1 pass / 1 genuine assertion failure (no load error). Each verdict
is OBSERVED with restoration verified. Raw `.log` output and extracted `.json`
records preserve invocation IDs, exact base/head hashes, times and counts.
This parser version emits no assertion identities/evidence strings in the JSON;
the independently removed decision and behavioral test remain inspectable.

The dirty-revision mutation removes revision-zero preservation for newly staged
and saved unknown IDs. The restore mutation removes cancellation after edits
made while the confirmed restore reads storage.

The final review also found a file-provided `__proto__` ID could hide its
quota failure through an inherited object setter. The native-transaction
regression ran 2 passes and 1 assertion failure before the fix, then 3 passes
and no failures after status initialization, copies and restore resets used
the same null-prototype helper. It verifies both refusal/retry rounds around
a restore. The two prototype-status logs retain the actual output.

The migration layer additionally qualifies retained validation evidence: a patch
that acknowledges every report as saved (including a refused transaction) turns
the existing retention test red. Its baseline passed 4 tests; the mutation ran
3 passes and 1 assertion failure. The official oracle returned OBSERVED with
attributable execution and verified restoration. The JSON records the exact
source head and parent-layer base.

```sh
node scripts/check-test-revert-oracle.mjs --base t3code/6679-storage-foundation --only apps/viewer/src/lib/flow/report-retention.ts --test apps/viewer/src/lib/flow/report-retention.test.ts --mutation docs/architecture/evidence/6679-user-content/mutations/retention-durability.patch --ci --json
```
