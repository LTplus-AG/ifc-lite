# Captured surface UI acceptance (#4380)

The actual local WebGPU viewer loaded the two-coloured seam-wall IFC and the
public boulder albedo GLB through Open/Add. The GLB derivation and original
source are recorded in [captured GLB evidence](../captured-glb/README.md).
No source, selection, capture or mutation state was injected. Browser automation
read store snapshots after normal pointer and toolbar interactions.

Two separate runs exercised **Author → Appearance → Create from scan**:

- Entire surface: 66,122 original triangles, then Create, Undo/Redo and IFC +
  images export.
- Select region: drag a rectangle in the dedicated preview, retain 40,087 whole
  triangles, then Create, Undo/Redo and IFC + images export.

Both runs began with two IFC walls selected by ordinary pointer/Meta-clicks.
Creation replaced all prior single/multi-model selection representations with
the new object; Undo cleared the removed object's selection. The committed
snapshots record those states. The original GLB remained independently loaded.

Each exported IFCZIP was opened through the normal loader in a fresh browser
run. Every re-imported triangle retained all three original source world/UV
corners: the oracle compares numeric coordinates within 0.1 mm and UVs within
1e-6, without quantized hash boundaries. The maximum observed world-coordinate
difference was 5.97e-8 m and UVs were identical. The JSON proofs record the exact
measured values. Actual mouse clicks selected the re-imported captured object.
Both sampler repeat flags remained true. Both exports contained the exact
original encoded JPEG, independently extracted from the GLB and byte-compared
against the archive image (`image-identity.json`).

The preview uses a separate instance of the existing renderer. Mounted tests
additionally prove that GPU loss disables creation and allows a fresh preview,
and that closing the dock during asynchronous renderer initialization cannot
upload a discarded view or retain its image lease. Those tests stub GPU
transport; the screenshots and end-to-end runs use actual WebGPU rendering.
Screen-region tests prove through-surface centroid selection without synthesized
border geometry. The source image and native UV seam conversion remain covered
by the extraction and native authoring tests.

The optional Browser service returned “Browser use requires a trusted Node REPL
browser service”; these local runs used the existing Playwright harness. Each
Chromium instance was closed after its run. Runtime identity is recorded in the
image proof. Shared-room acceptance is recorded separately.
