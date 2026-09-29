# Saved validation reports (#6500)

The Chromium witness loads the committed [building-architecture.ifc](https://github.com/LTplus-AG/ifc-lite/blob/326e124cf894bbaec7e56dc5126b16b07d123566/apps/viewer/public/samples/building-architecture.ifc) sample exported by IFC-manager for SketchUp and SketchUp 2024. It runs the associated IDS twice through the actual validation UI, renames the first saved report, and records a manual coordination warning and comment against that loaded model through the canonical checklist actions and the real **Save report** button.

After navigating to a fresh viewer with no loaded model or working checklist, Documentation inserts all three independently selected reports. The latest history entry is manual; selecting each earlier IDS result exercises changing report kind through the same picker. The exported PDF retains the original model name, manual checklist name and comment.

- [Saved history after two IDS runs and a manual review](saved-real-ifc-check-history.png)
- [Three independent document blocks with no live model](saved-checks-document-no-live-model.png)
- [Maximized document with all three report source selectors](saved-checks-document-maximized.png)
- [Actual exported PDF](saved-checks-document.pdf)

Run from the repository root after building dependencies and starting the viewer preview at port 6650:

```sh
PLAYWRIGHT_PORT=6650 pnpm exec playwright test tests/e2e/document-text.e2e.spec.ts --project=viewer-e2e-ci --workers=1 --reporter=line
```

The full spec also covers browser PDF text extraction, document pop-out rename/cancel/Escape, and named model fields with real authored PDF page breaks. The saved-report regression asserts source identifiers and model count as well as extracted text from the downloaded PDF; the screenshots supplement those assertions.

On 2026-09-29, all four Chromium tests passed (52.4s). A further saved-report run with the maximized screenshot passed (27.6s). The real IDS result was 11 checked, 8 passed, 3 failed (72%); the manual review records one warning with `Confirm survey origin`. These are observed outputs from the public sample, not expected values inferred from screenshots.
