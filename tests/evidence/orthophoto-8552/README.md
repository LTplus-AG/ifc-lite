# Orthophoto background evidence — #8552 / discussion #8294

The viewer places georeferenced aerial imagery in the committed IFC engineering
frame without replacing or remeshing the IFC. This is a flat background, with
editable elevation, visibility and opacity. Existing LandXML imagery draping
continues to use its terrain path.

## Real inputs

- `tests/models/georeferencer/MiniBIM-3.1-DO_01_VORM.ifc`: existing fixture,
  Revit 2025 / Bonsai–IfcOpenShell export, VORM Holding B.V.; EPSG:28992,
  IfcMapConversion E=90770, N=435320, H=3.5 metres.
  SHA256 `7d3ae097a2f1ca5e63f7698d12215cb58427cdb6a932e75e6bf1ca222bcf873b`.
- PDOK 2025 aerial, Schiehaven, Rotterdam: the exact WMS request and credit are
  in [pdok-source.json](./pdok-source.json). Bbox 90670,435220,90870,435420,
  EPSG:28992; 800×800 pixels at 0.25m. Attribution: **Samenwerkingsverband
  Beeldmateriaal / PDOK, CC BY 4.0**. [Provider](https://www.pdok.nl/-/luchtfoto-2025-nu-beschikbaar-bij-pdok?redirect=%2Fnieuws).
  Original JPEG SHA256 `85de970abd149d59459d3919296fddaae96618481b7a46e08b6842f43954cc43`.
  The browser also tested a GeoTIFF derivative made from the browser-decoded JPEG
  RGB pixels, with ModelPixelScale=(0.25,0.25,0), tiepoint=(0,0,0,90670,435420,0),
  projected EPSG:28992, PixelIsArea. No pixels were synthesized.
  TIFF SHA256 `310cb432d690d594aa5da168eccec335a0c8c6e1b8cac81cddc7db3717d73352`.
  JPEG sidecars: world file `0.25,0,0,-0.25,90670.125,435419.875` (one per line)
  and PRJ `PROJCS["Amersfoort / RD New",AUTHORITY["EPSG","28992"]]`.
- Existing NLS 2022 GeoTIFF (`landxml/imagery/nls-orthophoto-2022-m3143g-sw-road.tif`)
  supplies real half-metre pixels to the automated resampling regression.
  Existing 3D-Win M3 survey landmark 17897 supplies the independent PROJ oracle
  for EPSG:3067 → EPSG:3875. Fetch repository fixtures with `pnpm fixtures`.

Raw imagery is retained separately in managed evidence, not committed as a new
model fixture. Screenshots shown in the review chat are actual native Chrome/WebGPU renders.

## Validation

- Root Turbo targeted test run: **71 passed, 0 failed, 0 skipped**. Selector:
  `TEST_PATTERN="background-plan|orthophotoBackground|terrain-imagery|terrainImagery|AppearanceReferenceLibrary|reference-edit" pnpm test --filter=@ifc-lite/viewer`.
  Includes real WASM calibration, rotated/scaled IFC map conversion, nonlinear
  inverse reprojection, transparent sampling, bounds, US survey-foot conversion,
  committed frame validation, existing terrain imagery and reference editing.
- Root `pnpm typecheck`: passed across 69 packages, including 4,423 test files.
  Production viewer build passed as a prerequisite of the Turbo run.
  Receipt: `58efc20a-8469-481e-993e-40dcbd4ef7c9` (implementation `dcfd26549d`).
- Actual file-picker browser checks: JPEG+sidecars receipt
  `5245e4b2-6cc8-408b-893f-050d3dfb6568`; GeoTIFF receipt
  `997ae7fe-969a-4aca-916d-c8957f03e488`. Both retained the original model ID and
  **75,583 triangles**, with no page errors; visibility/removal passed, and
  GeoTIFF opacity editing passed.
- The final browser witness also tests a +1m calibrated elevation edit, requiring
  all four corners to retain XY and move Z by exactly 1m. Its result is stored
  in result.json. Final successful receipt:
  `0907535a-f9e0-4e04-b5c8-02df8d9e3885` (script `625ad33d8c`).
- Targeted oxlint passed. Post-commit `node scripts/pre-handoff.mjs`: all 12 gates
  passed, none skipped. The full viewer test suite and Rust suite were not run;
  changes are confined to viewer imagery integration, tests and documentation.

Reproduce the browser witness against a built viewer at localhost:5184:
`ORTHOPHOTO_IMAGE=/absolute/path/pdok-schiehaven-2025.tif node tests/e2e/orthophoto-background.manual.mjs`.
Use fleet admission and `ifc-gpu-check` on the managed host. The script accepts
`ORTHOPHOTO_BASE`, `ORTHOPHOTO_EVIDENCE` and `IFC_GPU_CDP_URL` overrides. T3's
embedded preview reported no compatible GPU adapter, so these images use the
repository's Playwright/native Chrome workflow.

## Scope and limits

Automatic placement requires the IFC's committed EPSG CRS and map conversion.
Same-CRS placement needs no datum grid; differing CRSs require an exact supported
projection operation. Missing metadata/grids produce actionable errors. The
existing reader supports 8-bit RGB/greyscale GeoTIFFs up to 64MP; output is bounded
at 2048 pixels on its longest side. This does not add terrain elevation inference
or online basemap streaming. A model/frame change during loading aborts placement.

