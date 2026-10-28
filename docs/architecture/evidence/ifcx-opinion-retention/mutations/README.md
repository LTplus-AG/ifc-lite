<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# IFCX opinion retention: surgical mutation evidence

`packages/ifcx/src/opinions.ts` is a new module. The CI revert oracle (`Changed tests observe production`) reverts production by deleting it, so `opinions.test.ts` fails to load (`ERR_MODULE_NOT_FOUND`), no assertion runs, and the oracle reports `REVERT-BROKE-BUILD` / INCONCLUSIVE. Following the oracle's advice, each behavioural decision below was checked with a surgical mutation instead, across all three production files.

Each patch is written mutant→fixed (the orientation of `git diff base...head`), and the oracle reverse-applies it. All rows were captured at head `35170f671` against `origin/main` `7fd1c4f5e`. Every run ended `OBSERVED` (exit 0) with restoration verified. The full result records are in `summary.json`.

| Patch | Module | Mutation | Test that went red |
|---|---|---|---|
| `record-values.patch` | `federated-composition.ts` | a layer's attribute values are never recorded, so no opinions are retained | `opinions.test.ts` |
| `record-skip-null.patch` | `federated-composition.ts` | a null removal is not retained as an opinion | `opinions.test.ts` |
| `default-on.patch` | `federated-composition.ts` | retention is on by default | `opinions.test.ts` |
| `order-strongest-first.patch` | `opinions.ts` | opinions are listed strongest first, so the last is no longer the composed value | `opinions.test.ts` |
| `drop-principal.patch` | `opinions.ts` | the provenance principal is not attached to opinions | `opinions.test.ts` |
| `compare-key-order.patch` | `opinions.ts` | object keys are not sorted, so key order alone counts as a disagreement | `opinions.test.ts` |
| `two-opinion-blind.patch` | `opinions.ts` | a disagreement between exactly two layers is not reported | `opinions.test.ts` |
| `overlay-drops-option.patch` | `index.ts` | addIfcxOverlay does not pass retainOpinions to composition | `opinions.test.ts` |
| `parse-drops-result.patch` | `index.ts` | the parse result never carries attributeOpinions | `opinions.test.ts` |

## Replay

Use a clean checkout of the branch with workspace packages built (`pnpm install --frozen-lockfile && pnpm turbo build --filter='@ifc-lite/ifcx^...'`). Copy the patches outside the tree, because the oracle refuses a dirty tree. Then run, for example:

```bash
node scripts/check-test-revert-oracle.mjs --base origin/main \
  --only packages/ifcx/src/opinions.ts --test packages/ifcx/src/opinions.test.ts \
  --mutation /tmp/opinion-mut/order-strongest-first.patch --ci --json
```

The other runs use the same shape, with `--only` set to the module in the table.
