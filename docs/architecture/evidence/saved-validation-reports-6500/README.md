# Saved validation reports (#6500)

The Chromium witness loads the committed [building-architecture.ifc](https://github.com/LTplus-AG/ifc-lite/blob/326e124cf894bbaec7e56dc5126b16b07d123566/apps/viewer/public/samples/building-architecture.ifc) sample exported by IFC-manager for SketchUp and SketchUp 2024. It runs the associated IDS twice through the actual validation UI, renames the first saved report, and records a manual coordination warning and comment against that loaded model through the canonical checklist actions and the real **Save report** button.

After navigating to a fresh viewer with no loaded model or working checklist, Documentation inserts all three independently selected reports. The latest history entry is manual; selecting each earlier IDS result exercises changing report kind through the same picker. Frozen IDS blocks expose original, compact and long presentation choices; choosing another saved IDS result preserves the selected presentation. The exported PDF retains the original model name, manual checklist name and comment.

The same browser run also renames the loaded model after evaluation, then inserts and refreshes a live IDS block. Both operations retain the name captured at evaluation, rather than relabeling old evidence with the renamed current model.

- [Saved history after two IDS runs and a manual review](saved-real-ifc-check-history.png)
- [Live IDS scope retained after model rename](live-evaluated-scope-after-model-rename.png)
- [Three independent document blocks with no live model](saved-checks-document-no-live-model.png)
- [Maximized document with all three report source selectors](saved-checks-document-maximized.png)
- [Actual exported PDF](saved-checks-document.pdf)

Run from the repository root after building dependencies and starting the viewer preview at port 6650:

```sh
PLAYWRIGHT_PORT=6650 pnpm exec playwright test tests/e2e/document-text.e2e.spec.ts --project=viewer-e2e-ci --workers=1 --reporter=line
```

The full spec also covers browser PDF text extraction, document pop-out rename/cancel/Escape, and named model fields with real authored PDF page breaks. The saved-report regression asserts source identifiers and model count as well as extracted text from the downloaded PDF; the screenshots supplement those assertions.

On 2026-09-30, all four Chromium tests passed (52.5s) on integrated production head `ef87480aec770d039691c25e090f0f7cb816c95e`, including live Add/Refresh scope after model rename and compact/long frozen report source changes. The real IDS result was 11 checked, 8 passed, 3 failed (72%); the manual review records one warning with `Confirm survey origin`. These are observed outputs from the public sample, not expected values inferred from screenshots.
