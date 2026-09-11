# Manual alignment: browser interaction control

This is a **same-source control**, not a real-world scan-to-IFC accuracy result.
The public boulder GLB and its full 66,122-triangle IFC capture share geometry.
That lets the interaction and frame conventions be checked without inventing
survey ground truth. The independent CRAS registration/coverage acceptance in
[#4381](https://github.com/LTplus-AG/ifc-lite/issues/4381) remains open.

## Accepted journey

1. Open the previously exported captured IFCZIP through normal Open, then add
   `boulder-albedo.glb` through normal Add model. Hide the GLB in the main view
   using its existing model visibility control; it remains in the source preview.
2. Open Author → Appearance → Align scan and choose the retained scan surface and
   IFC model. For the control, arrange the main camera against the actual preview
   camera and the known fixture translation. No geometry or observation state is
   injected. Each pair is created by clicking the preview and then the main IFC
   canvas; original triangle/barycentric identities are recorded by the product.
3. Pick four distributed fit and four separate check points. Calculate and open
   the aligned preview. `good.json` retains the complete request/report and pairs.
4. Remove P8, pick that source point again, and deliberately click a different
   visible target point. Calculate again. `wrong-heldout.json` records the new
   request/report; `summary.json` compares the measurements.

The accepted control measured fit RMS **0.00001547 m**, held-out RMS
**0.00002077 m**, and held-out maximum **0.00003779 m**. The deliberately wrong
check measured **0.075049 m** maximum and **0.037525 m** RMS. The fitted rotation
remained exactly unchanged (maximum component delta **0**), demonstrating that
check observations did not influence the fit. These small control residuals
include browser click/projection and float geometry precision; they do not state
the accuracy of the original scan or any unrelated IFC model.

Earlier exploratory clicks were rejected as a control: differently oriented
cameras exposed different front faces, and an existing IFC wall occluded one
intended scan point. The workbench correctly reported large check residuals.
Only the valid control is retained here; visibility is part of choosing a true
correspondence, not something the solver infers.

## Runtime and limits

`runtime.json` records fixture/runtime hashes and the source checkpoint. The
browser used real Chromium WebGPU on macOS. Builds/source edits were stopped
throughout each accepted run. Local Playwright was used after the in-app browser
service was unavailable. Browser processes close in `finally`.

The UI remains an **alignment preview**. It does not apply scan appearance,
reconstruct geometry, reposition a loaded model or certify registration accuracy.
Per-point and aggregate residuals remain visible for review. The captured IFC
fixture was created through the F5 viewer workflow documented in the existing
captured-mesh evidence; the large asset is not committed here.

Automated behavior checks additionally cover source removal, late IFC target
readiness, cancelled serialization, visibility versus geometry changes, clipped
view refusal, effective overlay GlobalId resolution, real raycaster barycentric
weights, worker cancellation and late response rejection. The clipping query is
exercised through the renderer's real render loop with inert GPU transport.

The complete eight-pair workflow was repeated with GLB opened first and the IFCZIP added second, without first selecting an IFC object. The [reverse-order report](glb-first/summary.json) reproduces the same residuals and unchanged fit rotation after the wrong held-out pick. This run also verifies lazy canonical mutation-view initialization; destination eligibility does not depend on prior selection.
