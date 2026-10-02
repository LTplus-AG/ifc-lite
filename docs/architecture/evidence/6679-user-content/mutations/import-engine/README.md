# Official scoped import mutation qualification for #6695


Head: `8cb3dfe37376248af455203373585ec288a06044`. Base: `6abfd08a327d55ec0e95716a8150317d1fdcb110` (`t3code/6679-library-migration`).

Each mutant-to-fixed patch removes one behavioral safety decision while keeping API/module interfaces intact. The official runner reverse-applied and forward-restored each patch in a clean detached checkout, sequentially. No source-presence or fake module assertions were added.

These are scoped behavioral witnesses, not an unfiltered revert CI pass. Later queued-autosave corrections are outside this source head.


## sparse-portable

Baseline: 20 pass. Mutant: 19 pass, 1 real assertion failure(s). Verdict: `OBSERVED`. Restoration: `verified`.

```sh
node scripts/check-test-revert-oracle.mjs --base t3code/6679-library-migration --only apps/viewer/src/lib/storage/content-backup.ts --test apps/viewer/src/lib/storage/content-library.test.ts --mutation docs/architecture/evidence/6679-user-content/mutations/import-engine/sparse-portable.patch --ci --json
```

## atomic-source-identity

Baseline: 10 pass. Mutant: 7 pass, 3 real assertion failure(s). Verdict: `OBSERVED`. Restoration: `verified`.

```sh
node scripts/check-test-revert-oracle.mjs --base t3code/6679-library-migration --only apps/viewer/src/lib/storage/content-database.ts --test apps/viewer/src/lib/storage/content-import-plan.test.ts --mutation docs/architecture/evidence/6679-user-content/mutations/import-engine/atomic-source-identity.patch --ci --json
```

## own-receipt-reference-merge

Baseline: 10 pass. Mutant: 8 pass, 2 real assertion failure(s). Verdict: `OBSERVED`. Restoration: `verified`.

```sh
node scripts/check-test-revert-oracle.mjs --base t3code/6679-library-migration --only apps/viewer/src/lib/storage/content-library.ts --test apps/viewer/src/lib/storage/content-import-plan.test.ts --mutation docs/architecture/evidence/6679-user-content/mutations/import-engine/own-receipt-reference-merge.patch --ci --json
```

## canonical-visible-draft

Baseline: 10 pass. Mutant: 9 pass, 1 real assertion failure(s). Verdict: `OBSERVED`. Restoration: `verified`.

```sh
node scripts/check-test-revert-oracle.mjs --base t3code/6679-library-migration --only apps/viewer/src/lib/storage/content-import-plan.ts --test apps/viewer/src/lib/storage/content-import-plan.test.ts --mutation docs/architecture/evidence/6679-user-content/mutations/import-engine/canonical-visible-draft.patch --ci --json
```

## Queued autosave correction (separate source head)

Head `ac538c4a6eb9f3809b2a315ce595f13f52ff1e17` includes the bounded own-receipt retry. Baseline11 pass, mutant10 pass/1 genuine assertion failure; OBSERVED, restoration verified. Latest source hashes are in queued-source-hashes.json.

```sh
node scripts/check-test-revert-oracle.mjs --base t3code/6679-library-migration --only apps/viewer/src/lib/storage/content-library.ts --test apps/viewer/src/lib/storage/content-import-plan.test.ts --mutation docs/architecture/evidence/6679-user-content/mutations/import-engine/queued-own-receipt-autosave.patch --ci --json
```
