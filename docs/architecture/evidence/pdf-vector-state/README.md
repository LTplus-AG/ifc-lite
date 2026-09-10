# PDF vector graphics-state preparation (#4406)

This is decoded-state evidence, not an IFC conversion or raster-fidelity claim.
All reports have `geometryReady=false` and explicitly retain pending page clipping,
curve flattening, stroke outlining, fill classification and paint-order composition.

## Inputs and measured scope

The [original CC0 controls and real public PDFs](../pdf-vectors/README.md) are
unchanged. Source hashes and page metadata are recorded in `actual-pages.json`.
The control PDF is reproducible with `tools/texture-authoring/pdf-vector-controls.py`;
the Featherston plan is Zaidaudi's CC BY-SA 3.0 source and HABS is the raster negative.
No new source artwork is copied into this evidence folder.

The actual pipeline was existing `runPdfJob` (`vectors` job, pinned PDF.js 6.3.289)
then rebuilt `IfcAPI.preparePdfVectorPage`. The control request in this folder is
its exact decoded DTO. Canonical WASM contract tests consume it again; it is not
a manually transcribed path fixture. The preparation run used physical paper
metres only, explicitly labelled `physical-paper-control-only`, not a fabricated
BIM calibration or drawing scale.

- Control page 1 retains four painted paths: a line, red fill, cubic and a dashed
  line with nonuniform rotation/scale. State qualifies, geometry does not.
- Control page 2 retains explicit clip, graphics-state dictionary (alpha) and text
  blockers. Its visible-looking paths cannot be published as an exact partial page.
- Featherston retains 3,166 painted paths but does not qualify because of its
  optional-content, clipping, form/group, text and hairline semantics.
- Raster HABS produces no paths and three image blockers, not a blank vector IFC.

## Independent conforming-coordinate comparison

`conforming-oracle.json` compares actual native output against PyMuPDF 1.26.5 /
MuPDF 1.26.10 `page.get_drawings()` for the controlled PDF. The oracle frame is
unrotated CropBox physical points: `[2,0,0,-2,-20,440]` from original PDF coordinates.
Line endpoints, all cubic controls, and the rotated/nonuniformly transformed line
endpoints agree within the recorded Float32-scale delta. Stroke widths/dashes are
retained in construction space by native preparation; this comparison does **not**
claim that MuPDF's scalar stroke-width extraction proves future stroke outlines.
It also does not compare flattened curves, clipping pixels or final IFC geometry.

Reproduce the decoded request with the existing PDF engine and the request recipe
in `control-request.json`, then pass its JSON to `IfcAPI.preparePdfVectorPage`.
Read `report.paths[*].commands` through `state.modelMetresFromPath`; divide by
`2*0.0254/72` to recover native PDF coordinates for this paper-space control and
apply the oracle affine above. Compare with `fitz.open(controlPdf)[0].get_drawings()`
while retaining the document owner. The committed real-WASM test repeats the
coordinate comparison against the independently measured oracle points.

Malformed controls placing `cm` or `q/Q` inside path construction were investigated
and excluded from conformance claims. ISO 32000-1 §8.2 disallows those graphics-state
operators inside a path object. Poppler also rendered the reordered malformed pair
identically; it is not evidence of a conforming PDF.js frame-loss defect. See the
[scope contract](../../pdf-vector-annotations.md#bounded-graphics-state-preparation).
