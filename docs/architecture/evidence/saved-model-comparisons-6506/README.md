# Saved model comparisons (#6506)

The Chromium regression loads the committed [architecture IFC sample](https://github.com/LTplus-AG/ifc-lite/blob/326e124cf894bbaec7e56dc5126b16b07d123566/apps/viewer/public/samples/building-architecture.ifc), its [derived revision](https://github.com/LTplus-AG/ifc-lite/blob/326e124cf894bbaec7e56dc5126b16b07d123566/apps/viewer/public/samples/building-architecture-rev-b.ifc), and the independent [bridge IFC sample](https://github.com/LTplus-AG/ifc-lite/blob/326e124cf894bbaec7e56dc5126b16b07d123566/apps/viewer/public/samples/infra-bridge.ifc). The source model headers identify IFC-manager for SketchUp 5.3.3 and SketchUp 2024 (24.0.594). The architecture revision is a derived regression fixture, rather than a separate authoring-tool export.

It runs **Data** comparisons through the actual UI and independently saves A/B, A/C, and B/C. A/B contains one added, one deleted, and one modified product; each comparison with C contains 75 added and 20 deleted products. The saved reports retain 3, 95, and 95 complete canonical rows respectively.

After reloading the viewer, only A is loaded. All three saved snapshots remain identical, and the history picker selects the A/C result. Documentation independently selects A/B, embeds its complete snapshot, shows its pair provenance and counts, and exports the actual PDF. The regression extracts that PDF using the viewer's production PDF text extractor and verifies both model names and all three A/B rows.

- [Three saved model-pair comparisons](history.png)
- [Saved A/B source and document preview after reload](document.png)
- [Actual exported PDF](document.pdf)

The shared table layout ellipsizes narrow cells in preview and PDF. The stored snapshot and CSV/JSON export retain complete identifiers and values. The PDF regression checks each displayed row's identifier and name prefix; the mounted document test separately verifies complete canonical row values passed to the PDF table renderer.

Run from the repository root after building dependencies:

```sh
pnpm exec playwright test tests/e2e/document-text.e2e.spec.ts --project=viewer-e2e-ci --grep '#6506' --workers=1 --reporter=line
```

The test starts its own source Vite server. On 2026-09-30, all five document browser scenarios passed in 1.2 minutes on the comparison branch rebased onto the integrated saved-validation-report changes. The scenarios cover mixed PDF text, popup behavior, scoped fields/page breaks, saved validation reports, and saved comparisons. These are observed IFC and downloaded PDF results; the screenshots supplement the behavioral assertions.

The production-revert oracle also returned `OBSERVED` against the stacked base `89695a72b`: reverting this feature left the four existing scenarios green and made the saved-comparison UI assertion fail. Restoring the production patch produced an attributable five-test green baseline, and the oracle verified byte-identical source restoration. No import weakening or oracle exemptions were used.
