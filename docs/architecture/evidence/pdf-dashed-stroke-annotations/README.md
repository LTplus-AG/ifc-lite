# Qualified dashed PDF stroke evidence (#4406)

This directory records one complete controlled dash conversion through the
production pipeline. [`dash.pdf`](dash.pdf) is the 701-byte CC0 `strokes`
control built by `fidelityControlPdf`: SHA-256
`31a59d41c4076af7eb740977ee1f5463466b529985060c749a60358a8dfe3dd7`.
It contains three blue straight strokes: a joined solid polyline, a `[3 2]`
dash-pattern line and a solid-line reset. The dash has eight visible runs.

[`dash-report.json`](dash-report.json) comes from the pinned PDF.js 6.3.289
adapter and a freshly built real WASM module. Its nine decoded operations
include both dash state changes. Preparation reports an exact page, three
convertible paths and no omissions. The same run plans ten styled fill regions,
applies the native plan through `StoreEditor`, and exports [`dash.ifc`](dash.ifc)
with `StepExporter`; [`dash-plan.json`](dash-plan.json) is the native geometry
used for the comparison.

[`dash-oracle.json`](dash-oracle.json) is an independent replay with MuPDF
1.26.5 and IfcOpenShell 0.8.2. IfcOpenShell reopens one `IfcAnnotation`, ten
representation items and the exact-conversion provenance, including the source,
decoder, calibration, request and fidelity digests. MuPDF renders the original
page with antialiasing disabled at four samples per PDF unit. All 460,800 pixel
centres agree with both the native 3D triangles and the independently reopened
`IfcAnnotationFillArea` boundaries; the native and independent 2D predictions
also agree exactly. The committed `dash-*.png` files are those source,
prediction and mismatch rasters.

This control establishes the common qualified even-pattern case through decode,
planning, export and independent reopen. Native tests separately pin negative
phase normalization, odd-array repetition, per-subpath reset, continuity across
vertices, the cap-versus-join boundary, affine area and ordinary native reopen.
Closed and curved dashed paths and zero-containing patterns remain omissions.
Combined fill-and-dashed-stroke paints can still refuse atomically when multiple
dash run boundaries create a composition crossing the current fill lattice
cannot qualify; the evidence makes no broader arbitrary-page claim.

Reproduce from a built checkout with the Python reader dependencies installed:

```sh
pnpm build:wasm
E=docs/architecture/evidence/pdf-dashed-stroke-annotations
TSX_TSCONFIG_PATH=apps/viewer/tsconfig.json node --import tsx \
  --import ./apps/viewer/src/test/vite-module-hooks.mjs \
  tools/texture-authoring/pdf-fidelity-evidence.mjs \
  control:strokes 1 $E/dash-report.json $E/dash.ifc
python3 tools/texture-authoring/pdf-fidelity-oracle.py \
  $E/dash.ifc $E/dash-oracle.json $E/dash-plan.json $E/dash.pdf
```
