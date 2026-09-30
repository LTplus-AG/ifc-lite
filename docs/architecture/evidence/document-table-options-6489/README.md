# Document table ordering and header colour (#6489)

The Chromium regression loads the committed architecture and bridge IFC samples, authored with IFC-manager for SketchUp 5.3.3 / SketchUp 2024. It selects products through the canonical IFC list pipeline, then creates two independent Documentation table blocks from that list.

The 31 products group into 14 IfcBuildingElementProxy, eight IfcBeam, eight IfcWall, and one IfcFurniture. The default order remains largest first with stable ties. Selecting By label on the second block changes its nested group order while preserving the first block. Dark purple uses white header text, Reset restores the existing slate header, and yellow uses black text. Reload retains the second block's ordering and colour.

- [Actual viewer preview and block controls](document.png)
- [Actual exported PDF](document.pdf)

The test extracts the downloaded PDF through the viewer's production PDF text extractor to verify group ordering. It also inspects bounded, decompressed PDF page streams to verify the custom header RGB occurs on at least two pages. This proves the browser PDF adapter consumes the configured palette, including repeated headers.

Run from the repository root:

```sh
PLAYWRIGHT_PORT=6489 pnpm exec playwright test tests/e2e/document-text.e2e.spec.ts --project=viewer-e2e-ci --workers=1 --reporter=line
```

All six document browser scenarios passed on 2026-09-30. They cover mixed PDF text, document popouts, scoped fields/page breaks, saved validation reports, saved comparisons, and these table options. The IFC federation emits a pre-existing reprojection warning for the bridge; these table assertions use product data independently of its scene placement.

The production-revert oracle returned `OBSERVED` against the saved-comparison base `0c1bb9b7d`. The existing mounted document table suite passed 13 tests; reverting only production produced 12 passes and one behavioral assertion failure. Forward restoration was verified byte for byte. No source assertions, import weakening, or exemptions were used.
