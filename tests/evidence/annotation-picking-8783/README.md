# Annotation picking (#8783)

Definition of done:

- Curves, filled regions and labels select their owning IfcAnnotation through the normal click path, both below and above the 500-mesh hydration budget.
- Lines have a four-CSS-pixel hit tolerance, independent of device pixel ratio.
- Hidden, isolated-away, section-clipped, cropped and non-drawable RTE content cannot be selected. Fill holes remain holes. Labels disappear with their anchor, matching rendering.
- Owner identity survives partition splitting, federation, placement and large world coordinates. Grid/reference overlays remain unowned.
- Upload replacement, clearing and device destruction invalidate retained targets and pending readbacks.
- An annotation-free pick performs no additional projection or geometry traversal.
- Behavioral regressions pass, real authoring-tool content supplies an oracle, and an adversarial review resolves findings before acceptance.

Implementation uses one screen-space/triangle hit tester for both picking routes. It retains owner identity on the existing uploads, reuses fill triangulation and the text pipeline's actual atlas layout, applies the shader's camera-dependent glyph scale and depth lift, and resolves overlay hits against mesh depth. Because overlays don't write depth, their draw order breaks overlapping-overlay hits. Label targets are the rendered glyph quads (including their halo), not individual opaque font texels; whitespace between glyph quads is not a target. Marquee selection is outside this click-picking issue.

Public model: [#653 attachment](https://github.com/LTplus-AG/ifc-lite/issues/653), `IFCAnnotationTest.zip`, containing `IFC_Annotation.ifc` and `IFC_Model.ifc`. The IFC header identifies the exporter as 3DEXPERIENCE Platform IFC4. Model data is not committed.

Validation (2026-11-05):

- [CI run 42022531801](https://github.com/LTplus-AG/ifc-lite/actions/runs/42022531801), source `c8757ac66a`: all checks passed, including build/WASM, typecheck, lint, changed-test production observation, 16 viewer shards, four Node shards and eight viewer E2E smoke shards.
- [Renderer tests](https://github.com/LTplus-AG/ifc-lite/actions/runs/42022531801/job/127233880085): 2,435 passed, zero failed, two skipped. Skips are the opt-in >2^24-vertex allocation case and a real-WebGPU adapter test; all #8783 regressions ran, including GPU-readback/CPU route selection at DPR 2, visibility, clipping, holes, glyph layout and stale readback rejection.
- `model-oracle.mjs` passed on PC/WSL, Node v24.21.0, using the successful CI build artifacts. It initializes the production WASM module from bytes because Node cannot fetch its file URL. The 590,169-byte public IFC exercised ten curve owners, ten fill owners and ten text owners (102 glyphs); each selected the expected owner and rejected hidden/isolated-away picks. Exact model hash and owners are in `model-result.json`; the oracle enforces that hash, all ten owners per family, and the recorded glyph count. The strengthened oracle passed, and a fixture with an appended newline was rejected before parsing. GPU transport is inert; this is a geometry/ownership oracle, not a browser screenshot or GPU rendering claim.
- Mutation challenge: temporarily disabling owned-line retention made the same real-model oracle fail (`undefined !== 34`, exit 7). Production source was restored in the same command. This checks that the oracle detects the original defect class.
- API surface regeneration produced no snapshot change. Local pre-handoff checks passed; its retained-free viewer check was skipped because local viewer dist was absent (CI separately built and exercised the viewer).

Adversarial review and hillclimb:

| Challenge | Resolution and evidence |
| --- | --- |
| Text targets drift from rasterized alignment, rotation or camera size | Pick descriptors come from the actual atlas upload; uploaded-layout regression and 102 real-model glyphs pass. |
| Large-coordinate or clipped content remains pickable | RTE drawable-envelope checks, homogeneous line clipping and fill hit-point clipping; national-grid, reversed-plane, box and hole regressions pass. |
| Federated or spatially split segments select another entity | Owner IDs follow segment splitting and partition regrouping; single/multiple-model hook regressions use canonical global IDs. |
| Replacement leaves stale asynchronous picks | Upload replacement clears retained targets before attempting GPU work; revision checks reject pending readbacks. |
| Public payload types lose ownership or disagree about readonly origins | Renderer line and clash-contact methods share the implementation contract; viewer derives its anchored type. CI typecheck and lint pass. |
| A green test merely reproduces its own fixture | Production route tests plus a real authoring-tool IFC oracle; the ownership mutation fails that oracle. |

The temporary unused-locals diagnostic edits used during investigation were removed after validation; the PR keeps the annotation defect scope. Picker lifecycle methods now document their ownership/visibility contracts.

External PR review found that annotation revision invalidation also discarded a valid mesh readback. The resolver now drops only stale annotation hits and preserves the separately validated mesh result. Delayed GPU-readback regressions cover both clearing/replacement and mesh hit/miss; fresh-head CI remains required before merge. Earlier fleet attempts failed during setup/source transfer or were cancelled while queued after being superseded; none count as passing validation. Their original receipts are preserved. CI and the executed oracle above are the acceptance evidence.
