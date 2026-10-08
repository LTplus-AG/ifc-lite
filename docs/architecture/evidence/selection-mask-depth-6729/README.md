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
report. The original source hashes are retained in `source-sha256-96.txt`.

Run the committed browser regression from the repository root:

```sh
pnpm test:e2e:ci tests/e2e/selection-mask-depth.e2e.spec.ts
```

The test imports the real production modules through this checkout's private
viewer dev server. Both existing viewer E2E projects explicitly include it.
An inverse run on original mask code uses the helper's `sampledDepthView=true`
argument to supply the original sampled-depth-only view; the corrected pass
requires the full depth/stencil attachment view.

## Review correction: 120-case depth-contract witness

Review correctly identified that the original `transparent-selected` case drew
only an opaque background behind the source; it did not draw the actual source
through the non-depth-writing scene pipeline. The 96-case native captures above
are preserved as observed and their transparency-selected claim is underqualified.
Their visible-source and 1 mm opaque-occlusion controls remain valid.

The corrected executable witness uploads the source with alpha 0.4 and actually
draws it through the non-depth-writing scene pipeline after the opaque background.
A companion `transparent-occluded` case draws that source behind an opaque
occluder and requires zero selected/hover mask pixels. The matrix is now 120 cases.
`swiftshader-restored-120.json` records the committed browser test passing all
120 cases with zero GPU errors; the adapter explicitly reported Google SwiftShader.
The native T3 automation host was unavailable for this revision, so this report
is software-adapter evidence. `source-sha256-120.txt` identifies its source.

## Scope

The transparency cases exercise the renderer's depth-write contract: a front
transparent draw does not occlude a selected opaque source; a selected transparent
source in front of an opaque source passes. The scene oracle executes the real main vertex stages without a fragment stage;
the masks execute their real production vertex/fragment stages. These depth-write
contract witnesses do not claim a full shaded viewer
or xray/ghost appearance acceptance. Entity ID 256 has zero geometry nudge and
isolates mask visibility from the separate mesh-depth-nudge contract. The existing
`ortho-depth-nudge.e2e.spec.ts` covers that contract's 30 mm controls; this witness
does not certify the reporter's assembly with millimeter clearances. The actual
reporter model remains unavailable. This correction therefore references #6729
without independently closing its broader assembly acceptance.

Initial concurrent checks under host memory pressure were incomplete (one browser
Targetcrashed timeout, cancelled root check and partial test run). They are not
passing evidence. Subsequent serialized runs are reported separately in the PR.
