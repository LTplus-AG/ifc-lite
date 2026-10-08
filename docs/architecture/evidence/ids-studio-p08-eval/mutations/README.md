<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# IDS Studio P-08 eval: surgical mutation evidence

All four production modules in this PR are new files (`scripts/ai-eval/ids/*.mjs`). The CI revert oracle (`Changed tests observe production`) reverts production by deleting them. Their tests then fail to load (`ERR_MODULE_NOT_FOUND`), so no assertion runs and the oracle reports `REVERT-BROKE-BUILD` / INCONCLUSIVE. That is expected for a PR that only adds modules. Following the oracle's own advice (`DECLARE A --mutation`), each behavioural decision below was checked with a surgical mutation instead.

Each patch is written mutant→fixed (the orientation of `git diff base...head`), and the oracle reverse-applies it. Captured at head `208cd431a` against `origin/main`. Every run ended `OBSERVED` (exit 0) with restoration verified. The full result records are in `summary.json`.

| Patch | Module | Mutation | Test that went red |
|---|---|---|---|
| `scorer-verdict-rule.patch` | `e2-scorer.mjs` | verdict rule matches `'failed'` instead of `'fail'`, so every candidate passes | `e2-scorer.test.mjs` |
| `scorer-empty-run.patch` | `e2-scorer.mjs` | an empty run reports agreement `1` instead of `null` | `e2-scorer.test.mjs` |
| `dataset-duplicate-id.patch` | `e2-dataset.mjs` | duplicate ids are no longer reported | `e2-dataset.test.mjs` |
| `dataset-verdict-flip.patch` | `e2-dataset.mjs` | a verdict that contradicts the corpus file prefix is no longer reported | `e2-dataset.test.mjs` |
| `e4-noop-edit.patch` | `e4-e5-datasets.mjs` | an E4 edit that changes nothing is no longer reported | `e4-e5-datasets.test.mjs` |
| `e5-behaviour.patch` | `e4-e5-datasets.mjs` | the wrong behaviour for an E5 category is no longer reported | `e4-e5-datasets.test.mjs` |
| `e5-invented-name.patch` | `e4-e5-datasets.mjs` | an "invented" name that exists in the schema is no longer reported | `e4-e5-datasets.test.mjs` |

`packages.mjs` only loads the built workspace packages. Every test imports through it, so any break in it fails every test at load. It carries no behavioural decision to mutate.

## Replay
Use a clean checkout of the branch with workspace packages built (`pnpm install --frozen-lockfile && pnpm turbo build --filter=@ifc-lite/ids...`). Copy the patches outside the tree, because the oracle refuses a dirty tree. Then run, for example:

```bash
node scripts/check-test-revert-oracle.mjs --base origin/main \
  --only scripts/ai-eval/ids/e2-scorer.mjs --test scripts/ai-eval/ids/e2-scorer.test.mjs \
  --mutation /tmp/p08-mut/scorer-verdict-rule.patch --ci --json
```

The remaining runs use the same shape. Each pairs a module with its own test file, as in the table.
