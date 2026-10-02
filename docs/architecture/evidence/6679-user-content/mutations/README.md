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
