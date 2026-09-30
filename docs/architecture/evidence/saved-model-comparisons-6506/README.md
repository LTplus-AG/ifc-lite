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

The test starts its own source Vite server. On 2026-09-30, all five document browser scenarios passed in 2 minutes 19 seconds on the comparison branch rebased onto the integrated saved-validation-report and recovery changes. The scenarios cover mixed PDF text, popup behavior, scoped fields/page breaks, saved validation reports, and saved comparisons. These are observed IFC and downloaded PDF results; the screenshots supplement the behavioral assertions.

The integrated recovery witness adds invalid and duplicate entries alongside the actual three saved IFC comparisons, then reloads through the production store. All three complete comparisons survive, the exact original bytes are archived, and the library visibly reports recovery. [Actual recovered history and warning](recovery.png) shows the retained A/B rows.

After the shared recovery notice adopted the foreground ink, the focused real-IFC browser scenario passed again in 36.9 seconds. It measures the warning's computed text colour against its actual opaque ancestor surface and requires normal-text contrast of at least 4.5:1. The [recorded measurement](recovery-contrast.json) is `rgb(9, 9, 11)` against `rgb(255, 255, 255)`, or 19.90:1; the recovery screenshot above was captured in that run.

The final automatic production-revert oracle ran every changed executable test against the integrated parent `ef87480` and returned `OBSERVED`: the actual browser file passed all five scenarios restored, and with the comparison feature removed four existing scenarios passed while the saved-library visibility assertion failed. New-module node tests cannot load under that complete production revert; they are not used as the behavioral witness. The oracle verified byte-identical restoration.

A separate surgical oracle removes only the reported read issue while leaving the real storage reads and archival policy intact. Its mounted baseline passes six cases, including the three recovery cases. With the report channel removed, the three recovery cases fail actual UI assertions while the three existing cases pass; the oracle returns `OBSERVED` and verifies restoration. The mounted fixture uses syntactically valid, invalid-shape JSON; the shared storage invariant suite separately covers malformed JSON, duplicate/partial arrays, inaccessible reads, quota-failed retries and known-neighbour deletion without resurrection.
