# Official scoped import mutation qualification for #6695


Head: `8cb3dfe37376248af455203373585ec288a06044`. Base: `6abfd08a327d55ec0e95716a8150317d1fdcb110` (`t3code/6679-library-migration`).

Each mutant-to-fixed patch removes one behavioral safety decision while keeping API/module interfaces intact. The official runner reverse-applied and forward-restored each patch in a clean detached checkout, sequentially. No source-presence or fake module assertions were added.

These are scoped behavioral witnesses, not an unfiltered revert CI pass. Later queued-autosave corrections are outside this source head.



## Replay setup

From the final PR checkout, retain the patches outside Git before checking out their historical source. Use an isolated checkout with built workspace dependencies. Fetch both preserved source branches and the migration branch so all pinned objects are available:

```sh
mkdir -p /tmp/ifc6679-replay-patches
cp docs/architecture/evidence/6679-user-content/mutations/import-engine/*.patch /tmp/ifc6679-replay-patches/
git fetch origin t3code/6679-import-mutation-source t3code/6679-import-final-mutation-source t3code/6679-library-migration
git checkout --detach 8cb3dfe37376248af455203373585ec288a06044
pnpm install
pnpm build --filter=@ifc-lite/viewer
```

Run the first four commands below at that source. For the queued-autosave command, check out `ac538c4a6eb9f3809b2a315ce595f13f52ff1e17` and rebuild first. The replay commands use the immutable migration base; captured stdout retains its original local branch argument. The copied patches survive checkout even though they were committed after the pinned runs.

## sparse-portable

Baseline: 20 pass. Mutant: 19 pass, 1 real assertion failure(s). Verdict: `OBSERVED`. Restoration: `verified`.

```sh
node scripts/check-test-revert-oracle.mjs --base 6abfd08a327d55ec0e95716a8150317d1fdcb110 --only apps/viewer/src/lib/storage/content-backup.ts --test apps/viewer/src/lib/storage/content-library.test.ts --mutation /tmp/ifc6679-replay-patches/sparse-portable.patch --ci --json
```

## atomic-source-identity

Baseline: 10 pass. Mutant: 7 pass, 3 real assertion failure(s). Verdict: `OBSERVED`. Restoration: `verified`.

```sh
node scripts/check-test-revert-oracle.mjs --base 6abfd08a327d55ec0e95716a8150317d1fdcb110 --only apps/viewer/src/lib/storage/content-database.ts --test apps/viewer/src/lib/storage/content-import-plan.test.ts --mutation /tmp/ifc6679-replay-patches/atomic-source-identity.patch --ci --json
```

## own-receipt-reference-merge

Baseline: 10 pass. Mutant: 8 pass, 2 real assertion failure(s). Verdict: `OBSERVED`. Restoration: `verified`.

```sh
node scripts/check-test-revert-oracle.mjs --base 6abfd08a327d55ec0e95716a8150317d1fdcb110 --only apps/viewer/src/lib/storage/content-library.ts --test apps/viewer/src/lib/storage/content-import-plan.test.ts --mutation /tmp/ifc6679-replay-patches/own-receipt-reference-merge.patch --ci --json
```

## canonical-visible-draft

Baseline: 10 pass. Mutant: 9 pass, 1 real assertion failure(s). Verdict: `OBSERVED`. Restoration: `verified`.

```sh
node scripts/check-test-revert-oracle.mjs --base 6abfd08a327d55ec0e95716a8150317d1fdcb110 --only apps/viewer/src/lib/storage/content-import-plan.ts --test apps/viewer/src/lib/storage/content-import-plan.test.ts --mutation /tmp/ifc6679-replay-patches/canonical-visible-draft.patch --ci --json
```

## Queued autosave correction (separate source head)

Head `ac538c4a6eb9f3809b2a315ce595f13f52ff1e17` includes the bounded own-receipt retry. Baseline11 pass, mutant10 pass/1 genuine assertion failure; OBSERVED, restoration verified. Latest source hashes are in queued-source-hashes.json.

```sh
node scripts/check-test-revert-oracle.mjs --base 6abfd08a327d55ec0e95716a8150317d1fdcb110 --only apps/viewer/src/lib/storage/content-library.ts --test apps/viewer/src/lib/storage/content-import-plan.test.ts --mutation /tmp/ifc6679-replay-patches/queued-own-receipt-autosave.patch --ci --json
```
