<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# IDS Studio P-06 bSDD: surgical mutation evidence

Most P-06 production modules are new files under `packages/ids-authoring/src/bsdd/`, `src/gate/bsdd.ts` and `src/lint/rules/bsdd.ts`. The CI revert oracle (`Changed tests observe production`) reverts them by deleting the files, so the tests cannot load and the verdict is `REVERT-BROKE-BUILD` / INCONCLUSIVE. Each main behavioural decision was instead checked with a surgical mutation.

Each patch is written mutant→fixed (the orientation of `git diff base...head`); the oracle reverse-applies it. Runs were made at head `9fdcc68de` against base `origin/main` (`bf65ed700`, merge base `80fd73691`). Every run ended `OBSERVED` (exit 0) with restoration verified. The full records are in `summary.json`.

| Patch | Module | Mutation | Test that went red |
|---|---|---|---|
| `gate-inactive-warning.patch` | `gate/bsdd.ts` | an inactive (deprecated) bSDD URI blocks like an unknown one instead of being a warning | `gate/gate-uri.test.ts` |
| `mapping-boolean.patch` | `bsdd/mapping.ts` | a bSDD `Boolean` property maps to `IFCLOGICAL` instead of `IFCBOOLEAN` | `bsdd/mapping.test.ts` |
| `bsdd002-system.patch` | `lint/rules/bsdd.ts` | IDSL-BSDD-002 accepts any system name, not only the bSDD dictionary name | `lint/rules/bsdd.test.ts` |
| `generator-optional.patch` | `bsdd/generator.ts` | dictionary-generated specifications default to required instead of optional | `bsdd/generator.test.ts` |
| `cache-ttl.patch` | `bsdd/cache.ts` | the bSDD cache serves an entry after its TTL has expired | `bsdd/offline.test.ts` |
| `parser-uri-requirements-only.patch` | `packages/ids/src/parser/xml-parser.ts` | the IDS 1.0 parser also reads `@uri` on an applicability facet (IDS 1.1 preview only) | `packages/ids/src/parser/xml-parser.test.ts` |

## Replay

Use a clean checkout of the branch with the workspace packages built (`pnpm install --frozen-lockfile && pnpm turbo build --filter=@ifc-lite/ids-authoring...`). Copy the patches outside the tree, because the oracle refuses a dirty tree. Then run, for example:

```bash
node scripts/check-test-revert-oracle.mjs --base origin/main \
  --only packages/ids-authoring/src/bsdd/cache.ts \
  --test packages/ids-authoring/src/bsdd/offline.test.ts \
  --mutation /tmp/p06-mut/cache-ttl.patch --ci --json
```

The other runs have the same shape, pairing each module with the test file in the table.
