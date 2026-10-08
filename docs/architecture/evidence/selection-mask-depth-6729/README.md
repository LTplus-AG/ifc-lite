# Selection mask depth witness (#6729)

This witness executes the production `mainShaderSource` vertex stages, canonical
individual-mesh upload, and `SelectionMaskPass` on an NVIDIA Blackwell WebGPU
adapter. The browser supplied all counts and adapter fields; these are measured
outputs, not expected-value fixtures.

`native-restored.json` records 96 cases: MSAA 1/4, flat/quantized/instanced source,
orthographic/perspective projection, flat/sloped plane, and four depth scenarios.
All visible source/selected/hover cases retain 576 interior pixels. A source hidden
by a 1 mm opaque occluder retains zero visible selected/hover pixels. The deliberate
all-selection silhouette retains 576 pixels in every case. No GPU errors occurred.
The source z=-2.0003 is off the quantization lattice, exercising canonical snapped
individual source reproduction rather than an already aligned plane.

`native-inverse.json` records the same 96-case matrix with the three original
production mask files restored from base e60ed32ee7299839cdce76e4a5c907ab0f1d4266.
All 24 opaque occlusion cases incorrectly retain 576 selected and hover pixels.
Both captures use the identical off-lattice source z=-2.0003 and executable
witness. `native-witness.png` is the native browser capture of the final passing
report. Source hashes identify the final production implementation and witness.

Run the committed browser regression from the repository root:

```sh
pnpm test:e2e:ci tests/e2e/selection-mask-depth.e2e.spec.ts
```

The test imports the real production modules through this checkout's private
viewer dev server. Both existing viewer E2E projects explicitly include it.
An inverse run on original mask code uses the helper's `sampledDepthView=true`
argument to supply the original sampled-depth-only view; the corrected pass
requires the full depth/stencil attachment view.

## Scope

The transparency cases exercise the renderer's depth-write contract: a front
transparent draw does not occlude a selected opaque source; a selected transparent
source in front of an opaque source passes. They do not claim a full shaded viewer
or xray/ghost appearance acceptance. Entity ID 256 has zero geometry nudge and
isolates mask visibility from the separate mesh-depth-nudge contract. The existing
`ortho-depth-nudge.e2e.spec.ts` covers that contract's 30 mm controls; this witness
does not certify the reporter's assembly with millimeter clearances. The actual
reporter model remains unavailable. This correction therefore references #6729
without independently closing its broader assembly acceptance.

Initial concurrent checks under host memory pressure were incomplete (one browser
Targetcrashed timeout, cancelled root check and partial test run). They are not
passing evidence. Subsequent serialized runs are reported separately in the PR.
