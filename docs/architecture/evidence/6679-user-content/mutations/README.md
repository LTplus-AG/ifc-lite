<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# #6679 foundation surgical mutation evidence

Source checkout: `/tmp/ifc6679-oracle-foundation`, detached `7e1bfc76dd5a153054291e70997a878f42e8d49b`.
The patches are mutant-to-fixed; the official runner reverse-applies each one.
All tests, schemas and module APIs remain intact. This qualifies two behavioral
safety decisions; it does not turn the automatic whole-file revert into a pass.

The historical hashes record capture provenance. To replay, use a throwaway
checkout at the head recorded in the adjacent JSON, build its dependencies,
and copy the final evidence directory into it (the artifacts were committed
after capture). Run sequentially using the recorded base SHA, rather than a
moving branch. The final tree also contains newer tests, so a fresh run there
can have more passing tests than the historical capture.

Run each command sequentially from the checkout:

```sh
node scripts/check-test-revert-oracle.mjs --base e134f79e92e18d35c48b23b4d8fd9e25998896e9 --only apps/viewer/src/lib/storage/content-library.ts --test apps/viewer/src/lib/storage/content-controller.test.ts --mutation docs/architecture/evidence/6679-user-content/mutations/dirty-revision.patch --ci --json
node scripts/check-test-revert-oracle.mjs --base e134f79e92e18d35c48b23b4d8fd9e25998896e9 --only apps/viewer/src/lib/storage/content-library.ts --test apps/viewer/src/lib/storage/content-controller.test.ts --mutation docs/architecture/evidence/6679-user-content/mutations/restore-edit-generation.patch --ci --json
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
node scripts/check-test-revert-oracle.mjs --base 7e1bfc76dd5a153054291e70997a878f42e8d49b --only apps/viewer/src/lib/flow/report-retention.ts --test apps/viewer/src/lib/flow/report-retention.test.ts --mutation docs/architecture/evidence/6679-user-content/mutations/retention-durability.patch --ci --json
```

The historical backup capture qualifies source-ID remapping with an API-preserving
mutation at the source head recorded below. Its then-current mounted Retry all
test checked bindings against independently imported comparison and report IDs.
That four-test capture is historical; it does not certify later test revisions.
The final mounted test now seeds durable conflicting source IDs and verifies both
independent copies, their rebound document references, and unchanged originals.
Baseline: 4 passes. Bypassing remapping: 3 passes and 1 assertion failure.
Official verdict: OBSERVED, attributable execution, restoration verified.
The adjacent import-reference-remapping artifacts preserve the exact source
head, base, command and invocation output. Replay from that recorded head:

```sh
node scripts/check-test-revert-oracle.mjs --base ec050f09e973eeb2af6eabdb53642800bed393e2 --only apps/viewer/src/lib/storage/content-backup-references.ts --test apps/viewer/src/components/viewer/ContentStorageNotice.test.tsx --mutation docs/architecture/evidence/6679-user-content/mutations/import-reference-remapping.patch --ci --json
```
