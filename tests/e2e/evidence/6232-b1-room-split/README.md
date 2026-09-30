# B1 Room classification: real-model split proof

This is captured browser evidence for charter #6232 / PR #6531, not a generated fixture or an output-pinning test.

Application source: `16a9dbd5fd1fbc905d6f8bb65a65c44d151999bf`. Later evidence-only commits leave that application source unchanged. The browser used an isolated fresh Chrome context, WebGPU, the public ArchiCAD `AC20-FZK-Haus.ifc`, and real WASM SHA-256 `91b587a48a4fc1e9911a6d279e83a3ec6513f5b29f0325d4b0445e35c33a171f`.

Five walls were added through the canonical viewer store in that loaded model. Actual Room More DOM inputs selected the minimum area, `Suite {n}` name pattern and EXTERNAL classification. Auto created two rooms. The exact command runtime already loaded by the UI then received Cut gesture endpoints derived from Suite 7's live retained layout: `(-5,-10)` to `(-5,-5)`.

The resulting three spaces include both Suite 7 pieces: both retain `.EXTERNAL.`, `IfcLite:GeneratedSpace` ObjectType, and `Pset_SpaceCommon.IsExternal=true`. One Undo removes the split sibling; the next undoes Auto. The captured result records those actual IFC reads and zero page errors. The screenshot shows the real model, Cut HUD and both Suite 7 hierarchy rows; the garden room is partly outside the camera frame, so the IFC result and real-DCEL contracts establish classification and outline behavior.

- [Screenshot](../6232-b1-room-split-ac20.png)
- [Captured IFC result](../6232-b1-room-split-ac20.json)

Targeted real-WASM contracts also cover USERDEFINED/ObjectType and an optional unset IFC4 classification, which this screenshot does not claim to demonstrate. All 19 layout/edit/occupancy contracts pass with zero skips; the previous corrective source failed both EXTERNAL and USERDEFINED split assertions by producing an INTERNAL sibling. Final source passed root Turbo typecheck (109 tasks; all 3,140 test files audited), root lint, module-size and source-text guards. Fresh final-head full CI and independent review remain merge requirements.
