# Real vector floor-plan acceptance (#4406)

This directory proves that the PDF-vector pipeline converts a real, permissively
licensed architectural drawing into native IFC geometry. The source is
[Typical House Floor Plan](https://commons.wikimedia.org/wiki/File:HouseFlrPlan.svg),
drawn by MrDrew508 and vectorized by Malyszkz. Wikimedia Commons identifies it
as GPL-2.0-or-later. The source, PDF derivative, IFC derivative and rendered
derivatives in this directory remain under that license; [`COPYING`](COPYING)
contains its terms.

The pinned original is [`HouseFlrPlan.svg`](HouseFlrPlan.svg), fetched from the
[Commons original-file URL](https://upload.wikimedia.org/wikipedia/commons/b/b8/HouseFlrPlan.svg):

- 7,768 bytes
- SHA-256 `7133dbc8effd298365c6882e8244cce9a6366109bf31c4b32f4f5023215113d9`
- Inkscape-authored vector paths representing exterior and interior walls,
  openings and a stair

[`HouseFlrPlan.pdf`](HouseFlrPlan.pdf) is a deterministic PDF derivative made
with CairoSVG 2.8.2, cairocffi 1.7.1, cairo 1.18.4 and pypdf 6.10.1. CairoSVG
creates a vector PDF; pypdf removes volatile metadata and regenerates stable
file identifiers. Repeating both steps on the recorded toolchain produced the
same 1,541-byte PDF and SHA-256
`de2e10df02059bc14a0eae6c1922cd2a699c1938a4c74c97978fccf1ef5df550`.

```sh
cairosvg HouseFlrPlan.svg -o HouseFlrPlan.raw.pdf
python - <<'PY'
from pypdf import PdfReader, PdfWriter
r = PdfReader("HouseFlrPlan.raw.pdf")
w = PdfWriter()
w.clone_document_from_reader(r)
w.metadata = None
w.generate_file_identifiers()
w.write("HouseFlrPlan.pdf")
PY
```

## Conversion result

[`report.json`](report.json) is a fresh production PDF.js 6.3.289 and WASM run
over the complete page. It contains one compound painted path (17 moves, 110
lines, 8 curves and 16 closes in the decoded path), reports one convertible
path, zero omissions, `exact: true`, and `rasterOnly: false`. The declared
model-space curve tolerance is 2 mm. A 1 mm request correctly exceeds the
unchanged four-million-unit shared geometry work budget; 2 mm is the smallest
tested accepted setting and visibly preserves the drawing's walls, openings
and stair.

[`HouseFlrPlan.ifc`](HouseFlrPlan.ifc) is the exported IFC4 result. Its one
`IfcAnnotation` has three fill regions and records the source digest, complete
CropBox, effective conversion boundary, calibration, 2 mm tolerance, request
digest and exact fidelity verdict in `IfcLite_PdfVectorConversion`.
[`HouseFlrPlan-plan.json`](HouseFlrPlan-plan.json) records the native plan used only by the independent
comparison oracle.

## Independent comparison

[`oracle.json`](oracle.json) records an independent reopen with IfcOpenShell
0.8.2 and raster comparison with MuPDF 1.26.5. IfcOpenShell found the IFC4
annotation, its three representation items and all three fill regions. Native
3D meshes and independently reopened 2D `IfcAnnotationFillArea` boundaries
produce identical 873 × 603 predictions (zero differing pixels).

Against the source PDF raster, both predictions differ at 5,777 of 526,419
pixel centres. Every difference is on a native boundary, the maximum distance
is 0.549 pixel, and zero pixels are unexplained. The images make the claim
directly assessable:

- [`source-mupdf.png`](source-mupdf.png): independent source PDF raster
- [`native-3d.png`](native-3d.png): rasterized native IFC meshes
- [`reopened-2d.png`](reopened-2d.png): independently reopened IFC 2D areas
- [`boundary-difference.png`](boundary-difference.png): boundary-only differences

## Reproduce the acceptance run

After `pnpm build:wasm`, from the repository root:

```sh
export TSX_TSCONFIG_PATH=apps/viewer/tsconfig.json
export PDF_FIDELITY_TOLERANCE_METRES=0.002
E=docs/architecture/evidence/pdf-real-vector-plan
node --import tsx --import ./apps/viewer/src/test/vite-module-hooks.mjs \
  tools/texture-authoring/pdf-fidelity-evidence.mjs \
  "$E/HouseFlrPlan.pdf" 1 "$E/report.json" "$E/HouseFlrPlan.ifc"
python tools/texture-authoring/pdf-fidelity-oracle.py \
  "$E/HouseFlrPlan.ifc" "$E/oracle.json" "$E/HouseFlrPlan-plan.json" \
  "$E/HouseFlrPlan.pdf"
```
