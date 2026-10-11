<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# IDS Studio P-02 authoring core: surgical mutation evidence

Every production file of `@ifc-lite/ids-authoring` is new in this PR (`packages/ids-authoring/src/**`). The CI revert oracle (`Changed tests observe production`) reverts production by deleting those files. The tests then fail to load, so no assertion runs and the oracle reports `REVERT-BROKE-BUILD` / INCONCLUSIVE. That is expected for a PR that adds a whole package. Following the oracle's own advice (`DECLARE A --mutation`), each key behavioural decision below was checked with a surgical one-line mutation instead.

Each patch is written mutant→fixed (the orientation of `git diff base...head`), and the oracle reverse-applies it. Captured at head `96e03a727` against `origin/main`. Every evidence run ended `OBSERVED` (exit 0) with restoration verified and a clean tree afterwards. The result records are in `summary.json`.

| Patch | Module | Mutation | Test that went red |
|---|---|---|---|
| `reducer-inverse-drops-cardinality-raw.patch` | `reducer/facet-ops.ts` | the restore snapshot of a removed/moved/replaced requirement drops `cardinalityRaw`, so undo is not an exact inverse | `reducer/apply.test.ts` |
| `facet-patch-loses-raw-relation.patch` | `reducer/facet-ops.ts` | the inverse of a `facet.patch` / `facet.setRelation` records `rawRelation: null` instead of the old raw value | `reducer/apply.test.ts` |
| `rename-property-ignores-scope.patch` | `compound/expand.ts` | `bulk.renameProperty` ignores its `scope` and renames in every specification | `compound/expand.test.ts` |
| `gate-entity-enum-not-grounded.patch` | `gate/grounding.ts` | enumerated entity names are not grounded, so an unknown name in a `oneOf` is accepted (GATE-ENT-001) | `gate/gate-entity.test.ts` |
| `gate-pdt-userdefined-undeclared.patch` | `gate/grounding.ts` | any predefined type outside the enumeration is accepted on a USERDEFINED-capable entity without a `declareUserDefinedType` (GATE-PDT-001) | `gate/gate-entity.test.ts` |
| `gate-pset-qto-never-verified.patch` | `gate/grounding-pset.ts` | `Qto_` names are never verified, even where the tables carry quantity sets (GATE-PSET-001) | `gate/gate-pset.test.ts` |
| `gate-redos-guard-skipped.patch` | `gate/values.ts` | patterns skip the ReDoS guard, so `(a+)+$` is accepted (GATE-VAL-004) | `gate/gate-structural.test.ts` |
| `gate-exclusive-range-empty.patch` | `gate/values.ts` | a range with equal bounds is reported empty only when BOTH ends are exclusive (GATE-VAL-002) | `gate/gate-structural.test.ts` |
| `units-mm-factor-inverted.patch` | `ops/units.ts` | the `mm` factor is `1e3` instead of `1e-3`, so 2400 mm is not 2.4 m | `ops/draft.test.ts` |
| `schema-accepts-infinity.patch` | `ops/json-schema-lite.ts` | the op validator rejects only `NaN`, so `Infinity` in a range passes | `ops/schema.test.ts` |
| `history-commit-keeps-redo.patch` | `history/history.ts` | a new commit keeps the redo branch instead of clearing it | `history/history.test.ts` |
| `sidecar-attach-ignores-fingerprint.patch` | `sidecar/sidecar.ts` | `attachSidecar` stamps ids positionally whenever the spec count matches, ignoring a fingerprint mismatch | `sidecar/sidecar.test.ts` |
| `reidentify-empty-identifier-matches.patch` | `match/reidentify.ts` | the `identifier` step matches two specs that both lack an identifier | `match/reidentify.test.ts` |
| `uuidv7-same-ms-reseeds.patch` | `uuid.ts` | ids minted in the same millisecond reseed the counter instead of incrementing it, breaking strict ordering | `uuid.test.ts` |

## Coverage finding (UNOBSERVED, now fixed)

At capture, `reducer-inverse-drops-description.patch` (`reducer/facet-ops.ts`, which drops `description` from the restore snapshot) came back `UNOBSERVED` (exit 1). The seeded apply∘inverse property test starts from buildingSMART corpus documents, and no corpus requirement carries a `description` or `instructions` attribute.

Fixed in 385ad04ba: `withImportLeftovers` in `reducer/apply.test.ts` now also gives requirements a `description` and `instructions`. Re-run at 385ad04ba:
- `reducer-inverse-drops-description.patch` is now `OBSERVED` (exit 0).
- `reducer-inverse-drops-instructions.patch` (`return snap;` instead of adding `instructions`) is also `OBSERVED` (exit 0).

`summary.json` holds the re-run records for both.

## Replay
Use a clean checkout of the branch with workspace packages built (`pnpm install --frozen-lockfile && pnpm turbo build --filter=@ifc-lite/ids-authoring...`). Copy the patches outside the tree, because the oracle refuses a dirty tree. Then run, for example:

```bash
node scripts/check-test-revert-oracle.mjs --base origin/main \
  --only packages/ids-authoring/src/history/history.ts \
  --test packages/ids-authoring/src/history/history.test.ts \
  --mutation /tmp/p02-mut/history-commit-keeps-redo.patch --ci --json
```

The remaining runs use the same shape. Each pairs the module in the table (under `packages/ids-authoring/src/`) with the test that went red.
