<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# IDS Studio P-04 lint: surgical mutation evidence

Every production module of the lint engine is a new file under `packages/ids-authoring/src/lint/`. The CI revert oracle (`Changed tests observe production`) reverts production by deleting such files. The tests then fail to load, no assertion runs, and the oracle reports `REVERT-BROKE-BUILD` / INCONCLUSIVE. That is expected for a PR that only adds modules. Instead, each main behavioural decision was checked with a surgical mutation.

Each patch is written mutant→fixed (the orientation of `git diff base...head`); the oracle reverse-applies it. Runs were made at head `ca71d464a` against base `origin/claude/ids-studio-p02-authoring-core` (`96e03a727`). Every run ended `OBSERVED` (exit 0) with restoration verified. The full records are in `summary.json`.

| Patch | Module | Mutation | Test that went red |
|---|---|---|---|
| `engine-cache-identity.patch` | `lint/engine.ts` | the cache no longer compares specification identity, so a rebuilt spec under an unchanged node index is served stale | `lint/engine.test.ts` |
| `suppress-reason-required.patch` | `lint/suppress.ts` | a suppression without a reason silences the rule | `lint/engine.test.ts` |
| `suppress-ancestor-spec.patch` | `lint/suppress.ts` | a suppression on a specification no longer covers its constraints | `lint/engine.test.ts` |
| `fix-ids-variant.patch` | `lint/fix.ts` | quick-fix op ids ignore the variant, so two fixes for one node share ids | `lint/engine.test.ts` |
| `fix-gate-filter.patch` | `lint/rules/util.ts` | quick fixes are no longer filtered through the grounding gate | `lint/rules/entity.test.ts` |
| `ent001-abstract.patch` | `lint/rules/entity.ts` | ENT-001 only fires when a class is abstract in more than one version | `lint/rules/entity.test.ts` |
| `pdt-userdefined-severity.patch` | `lint/rules/pdt-att.ts` | PDT-001 (error) also fires when the enumeration allows USERDEFINED (the corpus accepts such values) | `lint/rules/entity.test.ts` |
| `val005-lexical.patch` | `lint/rules/values.ts` | VAL-005 accepts "TRUE" / "False" (A-04: only lower case is valid) | `lint/rules/values.test.ts` |
| `regex003-portable.patch` | `lint/rules/regex.ts` | REGEX-003 no longer demotes `(?:…)` and `\/` to info | `lint/rules/regex.test.ts` |
| `solver-open-bounds.patch` | `lint/solver/solver.ts` | touching intervals overlap even when an end is exclusive | `lint/solver/solver.test.ts` |
| `solver-pattern-disjoint.patch` | `lint/solver/solver.ts` | two patterns without a sampled witness are declared disjoint | `lint/rules/card-spec.test.ts` |

`engine-cache-identity` and `fix-gate-filter` were first `UNOBSERVED`; the tests that now catch them were added in commit `ca71d464a` ("close two lint test gaps found by mutation").

## Replay

Use a clean checkout of the branch with the workspace packages built (`pnpm install --frozen-lockfile && pnpm turbo build --filter=@ifc-lite/ids-authoring...`). Copy the patches outside the tree, because the oracle refuses a dirty tree. Then run, for example:

```bash
node scripts/check-test-revert-oracle.mjs --base origin/claude/ids-studio-p02-authoring-core \
  --only packages/ids-authoring/src/lint/rules/entity.ts \
  --test packages/ids-authoring/src/lint/rules/entity.test.ts \
  --mutation /tmp/p04-mut/ent001-abstract.patch --ci --json
```

The other runs have the same shape, pairing each module with the test file in the table.
