# Document behavior oracle evidence (#6612, #6620)

The document refactor extracts modules that its new tests import. Its first
whole-file revert could not load those imports and returned
`REVERT-BROKE-BUILD`. The subsequent native chart-toast regression supplies an
actual behavioral witness through the existing DocumentPanel interface.

The standard whole-file oracle now returns `OBSERVED`, exit 0, with source
restoration verified. Its baseline passed all 74 tests. The mounted native
panel test passed 14 tests before reversion and failed one real assertion
afterward: chart errors were omitted from the export toast. The other three
test files cannot load after wholesale deletion of the extracted modules;
the oracle's exact-file ledger accepts the genuine panel witness.

Four independent surgical mutations also retain every module/export and
produce assertion failures. Each uses the authoritative
`scripts/check-test-revert-oracle.mjs`, with a green attributable baseline
and verified source restoration.

| Mutation | Baseline | Mutated behavior | Result |
| --- | --- | --- | --- |
| [Literal braces](literal-braces.patch) | 17 pass | 2 assertions fail when captured names become template expressions | OBSERVED |
| [Chart toast](chart-toast.patch) | 14 pass | 1 assertion fails when native export omits the chart count | OBSERVED |
| [Chart result](chart-result.patch) | 43 pass | 1 assertion fails when PDF chart-failure metadata is discarded | OBSERVED |
| [Chart warnings](chart-warnings.patch) | 43 pass | 1 assertion fails when artifact warnings omit chart errors | OBSERVED |

The mounted panel test parses IFC, runs native chart aggregation, records
native PDF output, and mounts the real Toaster. The literal-name assertions
render captured evidence with brace-containing names while ordinary authored
bindings continue resolving. None of these tests assert source text or merely
the existence of a new export.

Machine-readable receipts are [default.json](default.json),
[literal-braces.json](literal-braces.json), [chart-toast.json](chart-toast.json),
[chart-result.json](chart-result.json), and [chart-warnings.json](chart-warnings.json).
They record the isolated checkout (document layer plus chart-toast fix), actual
runner results, timestamps, attribution and restoration verdicts.

To reproduce a surgical case, build from the repository root and run the
oracle with `--base 271f35684ba57944b82f49505e51573d952cdcee`,
`--mutation` pointing to its patch, `--ci --json`, and `--test` selecting:

- Literal braces: `apps/viewer/src/lib/document/build-report-document.test.ts`
  and `apps/viewer/src/lib/document/model-bindings.test.ts` (repeat `--test`).
- Chart toast: `apps/viewer/src/components/viewer/document/DocumentPanel.table.test.tsx`.
- Chart result or warnings: `apps/viewer/src/lib/document/document.test.ts`.

The patches use the oracle's forward orientation and are reverse-applied by
the tool. Run in a clean isolated checkout; the tool restores production and
verifies the tree afterward. These receipts measure source restoration,
not viewport restoration. The standard gate remains enabled; no exception
label or CI modification was used.
