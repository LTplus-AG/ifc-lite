# IDS summary units — #6551

The supplied IDS and IFC were compared locally on 2026-10-01 using the
current IFC Lite parser/IDS bridge and validator, IFC Tester 0.9.0, and
IfcOpenShell 0.8.4.post1. The private files and full validation outputs are
not included in this repository. No files were uploaded to either validator.

All 71 specification applicability sets matched by express ID. For every
requirement, the failed-entity set matched exactly. Aggregate results:

| Unit | Passed | Total |
| --- | ---: | ---: |
| Specifications | 54 | 71 |
| Requirements | 310 | 430 |
| Entity × requirement checks | 43,826 | 90,303 |
| Entity × specification results | 70 | 7,972 |

The new viewer check summary was run against the same local IFC Lite report
and returned 43,826 passed checks, 46,477 failed checks, 90,303 total checks,
48% pass rate, and 310/430 passing requirements. IFC Tester's checks summary
also returns 48%. The engine's entity summary remains 70/7,972 (bounded to 1%).
These are different units, not differing validation outcomes.

The regression test parses a synthetic STEP model with two walls and two
attribute requirements. Both walls have a Name; one of their Tags fails.
The mounted IDS panel therefore shows 3/4 passing checks (75%) alongside 1/2
passing entity–specification results (50%). This also exercises the actual
panel wiring, omitted passing entities, repeated applicability across
specifications, empty populations, required empty specifications, and locale
number formatting. Additional cases cover repeated specification identifiers,
optional/prohibited requirements, cardinality failures, capped validation, and
evaluator errors. The HTML export uses the same aggregate helper and is
checked for omitted passing entities and unavailable incomplete totals.

The screenshot below shows that synthetic model's report rendered in the
collaborative browser at a 440px panel width. It contains no private model data.

![Synthetic IDS summary with both units](synthetic-summary.png)

Validation: `pnpm typecheck` passed, including test-source coverage; the viewer
production build passed. Eleven new regression tests, ten existing IDS panel localization tests, and
21 existing HTML/JSON export tests passed through root Turbo. The viewer's existing hash shard
selection was used with `--env-mode=loose` so Turbo passes the shard variables:

```sh
TEST_SHARDS=1000003 TEST_SHARD=625285 pnpm test --filter=@ifc-lite/viewer --env-mode=loose
TEST_SHARDS=1000003 TEST_SHARD=523016 pnpm test --filter=@ifc-lite/viewer --env-mode=loose
TEST_SHARDS=1000003 TEST_SHARD=186322 pnpm test --filter=@ifc-lite/viewer --env-mode=loose
```

Touched-file oxlint, module-size, i18n-literal, source-text-assertion, and diff
whitespace checks passed. The full viewer test run was stopped after it stalled
in the unrelated `FlavorDialog.unapplied-toast.test.tsx` file; it is not claimed
as passing.

Production-revert oracle: `node scripts/check-test-revert-oracle.mjs --base
origin/main --test apps/viewer/src/components/viewer/IDSPanel.check-summary.test.tsx
--ci --json` returned **OBSERVED**. The fixed baseline passed; reverting the
production changes turned behavioral assertions red, and restoration was
verified. Thus the test detects missing production wiring, not just the
presence of a helper.
