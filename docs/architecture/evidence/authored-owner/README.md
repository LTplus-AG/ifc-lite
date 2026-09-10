# Multi-part authored-owner publication

Controlled browser acceptance for the shared transaction prerequisite of #4406.
The input is the two-colour PDF control decoded and independently checked in
[the native fill evidence](../pdf-fill-annotations/README.md). This is a known
control, not a claim of arbitrary production-PDF fidelity.

The normal viewer Open path loaded the existing F5 captured IFCZIP. A browser
harness called the actual appearance Web Worker with a frozen effective IFC
snapshot and verified `sourceIfcSha256` before calling `commitAuthoredProduct`.
No viewer geometry was invented or substituted. The native result contained one
`IfcAnnotation`, two untextured parts, sixteen vertices and sixteen triangles.

- [Created](created.png): two real WebGPU colour batches, no image/UV/texture.
  The red fill retains its hole and the overlaid blue region.
- One Undo removed both parts and one Redo restored them. Actual mouse picking
  selected the annotation through the ordinary viewer interaction handler.
- The normal STEP exporter serialized the effective IFC; a fresh page loaded it
  through Open. [Reopened](reopened.png) preserves both colours and the hole.
  All indexed world-space corners match exactly (maximum measured error: zero).
- [Selected after reimport](reopened-selected.png) shows ordinary picking resolves
  the owner as `IfcAnnotation` with the native name and object type.

[browser.json](browser.json) records source/output/WASM digests, original and
reimported geometry, RGB values, GPU counts and the actual reimport pick location.
The source PDF digest and request are linked by the native fill report. The
harness uses the command API because the PDF representation-choice UI is a
subsequent slice; these screenshots do not claim a new creation button.

Node 22.23.2 validation: root Turbo renderer suite passes 1,468 tests with one
existing skip; actual WASM/host command tests pass two single/federated PDF cases,
seven existing image cases and six existing capture cases. Scene invariants cover
mixed flat/textured parts, distinct concurrent detached owners, later-allocation
rollback, invalid geometry, scene clear and changed model placement. Native host
checks cover all-parts Undo/Redo, later-part edit refusal, real STEP reimport and
zero retained image resources for untextured fills.

AC20's multiple root 3D contexts are refused by the existing native authored
context contract. This run used an eligible single-context target and did not
change that target-selection policy.
