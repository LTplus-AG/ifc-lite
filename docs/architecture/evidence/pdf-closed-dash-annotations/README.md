# Versioned closed PDF dash evidence (#4583, #4406)

This directory records the same controlled closed-dash content under the PDF
1.x compatibility policy and the explicit PDF 2.0 closure rule. The CC0 controls come
from `fidelityControlPdf`: [`closed-dashes.pdf`](closed-dashes.pdf) is PDF 1.7
(790 bytes, SHA-256
`0e454a6d5a52834af4e494902c37526a6822bec5793aa5e9711726f049392e31`),
while [`closed-dashes-v2.pdf`](closed-dashes-v2.pdf) uses a Catalog
`/Version /2.0` override (803 bytes, SHA-256
`4e62b68a2e9d93c260af98386b5fff4dc079f8f457e0cc0a0941f4da24c59d0f`).
Their content streams are identical: one explicit `h ... S` contour whose
first and last on-dash pieces meet at the seam, one close-and-stroke `s`
contour with a gap at the seam, and one paint containing open and explicitly
closed subpaths.

The paired `*-report.json` files come from PDF.js 6.3.289 and a freshly built
real WASM module. PDF.js reports effective versions `1.7` and `2.0`, including
the Catalog override. Both pages are exact, with three convertible paints and
no omissions. The prepared paths record `capped` closure for PDF 1.7 and
`joined` closure for PDF 2.0. Each production run plans and exports an IFC4
annotation through `StoreEditor` and `StepExporter`; the paired `*.ifc` and
`*-plan.json` files retain those results.

The paired `*-oracle.json` files reopen the exports with IfcOpenShell 0.8.2.
Both contain one `IfcAnnotation`, 14 representation items, exact-conversion
provenance, and the effective `SourcePdfFormatVersion`; their native 3D meshes
and independently reopened 2D boundaries predict identical pixels.

For PDF 1.7, MuPDF 1.26.5 agrees with both predictions at all 460,800 sampled
pixel centres. For PDF 2.0, ISO 32000-2 explicitly requires the first and last
on-dash pieces of a closed subpath to be joined. MuPDF 1.26.5 renders the 2.0
control exactly as it renders 1.7, leaving 128 pixels at the two joined seams
different from both native and independently reopened IFC output. The 2.0
oracle records that reader divergence instead of treating MuPDF's capped result
as normative; the committed mismatch images show only those two seam joins.
The oracle's version-specific flag requires an exact 2.0 plan, no omission
extents, nonzero MuPDF divergence, and zero native-versus-reader differences.

Native tests separately pin the specification boundary: ordinary seam-on
pieces remain independently capped in PDF 1.x, PDF 2.0 merges them with the
configured join, a seam gap stays capped in both versions, explicit and
paint-time closure agree, and mixed subpaths reset phase. An absent, malformed
or unsupported effective version reports `dashVersion`; a PDF 1.x dash covering
the full perimeter reports `dashTopology` until coincident caps have a bounded
multi-ring decomposition. Curved and zero-containing dashes remain omissions.

[`native-load.json`](native-load.json) records the required performance control
on AC20-FZK-Haus using independently compiled base and branch binaries in
base/branch then branch/base order, five iterations each. All 20 measurements
retain 285 meshes, 35,940 vertices, 19,456 triangles and ordered mesh FNV
`25ac885b6ff4ad00`. Paired wall-time medians are 14.28/16.03 ms and
14.45/14.65 ms; this resolves no material normal-load regression at the probe's
coarse resolution and makes no PDF-authoring throughput claim.

Reproduce from a built checkout with the Python reader dependencies installed:

```sh
pnpm build:wasm
E=docs/architecture/evidence/pdf-closed-dash-annotations
TSX_TSCONFIG_PATH=apps/viewer/tsconfig.json node --import tsx \
  --import ./apps/viewer/src/test/vite-module-hooks.mjs \
  tools/texture-authoring/pdf-fidelity-evidence.mjs \
  control:closedDashes 1 $E/closed-dashes-report.json $E/closed-dashes.ifc
TSX_TSCONFIG_PATH=apps/viewer/tsconfig.json node --import tsx \
  --import ./apps/viewer/src/test/vite-module-hooks.mjs \
  tools/texture-authoring/pdf-fidelity-evidence.mjs \
  control:closedDashesV2 1 $E/closed-dashes-v2-report.json $E/closed-dashes-v2.ifc
python3 tools/texture-authoring/pdf-fidelity-oracle.py \
  $E/closed-dashes.ifc $E/closed-dashes-oracle.json \
  $E/closed-dashes-plan.json $E/closed-dashes.pdf
python3 tools/texture-authoring/pdf-fidelity-oracle.py \
  $E/closed-dashes-v2.ifc $E/closed-dashes-v2-oracle.json \
  $E/closed-dashes-v2-plan.json $E/closed-dashes-v2.pdf \
  --pdf2-closed-dash-reader-divergence
```

The normative PDF 2.0 seam sentence is in ISO 32000-2 section 8.4.3.4. The
[ISO catalogue entry](https://www.iso.org/standard/75839.html) identifies the
current standard, and the PDF Association provides its
[sponsored no-cost distribution](https://pdfa.org/sponsored-standards/).
