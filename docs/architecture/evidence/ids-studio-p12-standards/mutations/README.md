<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# IDS Studio P-12 standards: surgical mutation evidence

P-12 adds new modules: the IDS 1.1 preview (`packages/ids/src/preview/*.ts`, plus
`audit/structural/shapes.ts`) and the conformance dashboard
(`scripts/ids-conformance/**`). The CI revert oracle (`Changed tests observe
production`) reverts production by deleting new files, so their tests fail at
load and a per-module verdict is `REVERT-BROKE-BUILD` / INCONCLUSIVE. As the
oracle advises, each behavioural decision below was checked with a surgical
`--mutation` instead.

Each patch is written mutant→fixed (the orientation of `git diff base...head`)
and the oracle reverse-applies it. Base: `origin/claude/ids-studio-p01-engine`.
Every run ended `OBSERVED` (exit 0) with restoration verified; heads and full
records are in `summary.json`.

| Patch | Module | Mutation | Test that went red |
|---|---|---|---|
| `tolerance-tie-rounding.patch` | `tolerance.ts` | an exact tie always rounds up instead of to even | `tolerance.test.ts` |
| `features-nested-partof.patch` | `features.ts` | nested partOf facets are not detected, so the writer no longer refuses them without the flag | `ids11-preview.test.ts` |
| `parse-applicability-uri.patch` | `parse-ids11.ts` | the preview parser drops uri on applicability facets | `ids11-preview.test.ts` |
| `partof-nested-ignored.patch` | `partof-nested.ts` | a related element that fails a nested facet still matches | `ids11-preview.test.ts` |
| `audit-duplicate-identifier.patch` | `audit.ts` | duplicate specification identifiers are no longer reported | `ids11-preview.test.ts` |
| `shapes-applicability-uri.patch` | `shapes.ts` | the preview structural audit rejects uri on applicability facets | `ids11-preview.test.ts` |
| `matrix-invalid-agreement.patch` | `matrix.mjs` | any audit answer counts as agreeing with an invalid- case | `matrix.test.mjs` |
| `corpus-unknown-prefix.patch` | `corpus.mjs` | a file with an unknown prefix is skipped silently | `matrix.test.mjs` |
| `report-error-not-counted.patch` | `report.mjs` | errors are dropped from the denominator, inflating agreement | `report.test.mjs` |
| `command-verdict-allowed.patch` | `command.mjs` | a verdict that does not answer the question is accepted | `adapters.test.mjs` |
| `spec-verdict-prohibited.patch` | `thatopen-components.mjs` | more elements apply than maxOccurs allows (including a prohibited specification) and the verdict is still pass | `adapters.test.mjs` |
| `ifc-lite-audit-verdict.patch` | `ifc-lite.mjs` | the audit column ignores error-severity issues | `run.test.mjs` |
| `run-unknown-argument.patch` | `run.mjs` | an unknown CLI argument is ignored | `run.test.mjs` |

`spec-verdict-prohibited` first targeted an explicit `maxOccurs === 0` branch
and came back **UNOBSERVED**: the branch was redundant (`maxOccurs="0"` is the
`applicable > maxOccurs` case). The branch was deleted in `ae9be3a5a` and the
mutation retargeted at the bound check that does the work.

Whole diff, no `--mutation` (`summary.json`, first entry): **OBSERVED**
at head `a311d32f6`. Changes to existing modules (validator guard,
partOf checker, writer, audit) turned assertions red; the new-module test files
failed at load, which is why the surgical runs above exist.

Not mutated, and why:

- `preview/types.ts`: types only, no runtime code.
- `scripts/ids-conformance/lib/adapters/thatopen-process.mjs`: needs the
  third-party engine installed outside the lockfile; it runs only in the
  dashboard run (`node scripts/ids-conformance/run.mjs --thatopen-root …`), whose
  output is committed in `docs/guide/ids-conformance.json`.
- `scripts/ids-conformance/proposed-cases.mjs`: a generator; its committed
  output is checked by `packages/ids/src/__corpus__/proposed-cases.test.ts`
  (each file is the writer's own output and gets the verdict in its name).
- The `ifc-lite` adapter test in `scripts/ids-conformance/run.test.mjs` needs the
  built workspace and skips without it; the `ifc-lite-audit-verdict` run above was
  made with the workspace built.

## Replay

On a clean checkout of the branch with the workspace built
(`pnpm install --frozen-lockfile && pnpm turbo build --filter=@ifc-lite/ids...`),
copy the patches outside the tree (the oracle refuses a dirty tree), then for
example:

```bash
node scripts/check-test-revert-oracle.mjs --base origin/claude/ids-studio-p01-engine \
  --only packages/ids/src/preview/tolerance.ts --test packages/ids/src/preview/tolerance.test.ts \
  --mutation /tmp/p12-mut/tolerance-tie-rounding.patch --ci --json
```

Every other run has the same shape: the module and test named in the table.
