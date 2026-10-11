<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# IDS Studio P-10 trust & teamwork: surgical mutation evidence

Most P-10 production modules are new files (`packages/ids-authoring/src/diff/`, `merge/`, `revision/`, `comments/`, `testing/`, `reducer/comment-ops.ts`, `reducer/test-ops.ts`, and `packages/ids/src/constraints/xsd-examples.ts` / `xsd-regex-ast.ts`). The CI revert oracle (`Changed tests observe production`) reverts them by deleting the files, so the tests cannot load and the verdict is `REVERT-BROKE-BUILD` / INCONCLUSIVE. Each main behavioural decision was instead checked with a surgical mutation.

Each patch is written mutant→fixed (the orientation of `git diff base...head`); the oracle reverse-applies it. Runs were made at head `65b6c8ae1` against base `origin/main` (`2a08aeb4a`). Every run ended `OBSERVED` (exit 0) with restoration verified. The full records are in `summary.json`.

| Patch | Module | Mutation | Test that went red |
|---|---|---|---|
| `diff-uri.patch` | `diff/compare.ts` | the diff ignores a facet `uri` change | `diff/changelog.test.ts` |
| `merge-sidecar-theirs.patch` | `merge/sidecar.ts` | a suppression or test case changed only by theirs is dropped (ours always wins) | `merge/merge.test.ts` |
| `revision-chain.patch` | `revision/verify.ts` | verification no longer checks the recorded parent hash | `revision/revision.test.ts` |
| `revision-content.patch` | `revision/verify.ts` | verification no longer checks the content hash (tampered content passes) | `revision/revision.test.ts` |
| `comment-resolve-inverse.patch` | `reducer/comment-ops.ts` | undoing a resolve restores the new flag instead of the old one | `comments/comments.test.ts` |
| `junit-failures.patch` | `testing/junit.ts` | JUnit `failures` counts errors instead of failures | `testing/runner.test.ts` |
| `xsd-examples-verify.patch` | `packages/ids/src/constraints/xsd-examples.ts` | candidates are not checked with `matchConstraint` | `packages/ids/src/constraints/xsd-examples.test.ts` |
| `xsd-noncapturing-group.patch` | `packages/ids/src/constraints/xsd-regex-ast.ts` | `(?:…)` is not read as a group | `packages/ids/src/constraints/xsd-examples.test.ts` |

`comment-resolve-inverse` was first `UNOBSERVED`. The test that now catches it was added in commit `65b6c8ae1`.

## Replay

Use a clean checkout of the branch with the workspace packages built (`pnpm install --frozen-lockfile && pnpm turbo build --filter=@ifc-lite/ids-authoring...`). Copy the patches outside the tree, because the oracle refuses a dirty tree. Then run, for example:

```bash
node scripts/check-test-revert-oracle.mjs --base origin/main \
  --only packages/ids-authoring/src/revision/verify.ts \
  --test packages/ids-authoring/src/revision/revision.test.ts \
  --mutation /tmp/p10-mut/revision-chain.patch --ci --json
```

The other runs have the same shape, pairing each module with the test file in the table.
