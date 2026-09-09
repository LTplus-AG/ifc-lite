# Reference placement and textured annotation acceptance

The local browser acceptance run exercises the mounted Author → Appearance dock,
not a standalone component. A 512 × 512 asymmetric image is calibrated from two
visible landmarks to a 2 m span and placed as an independent reference. An
ordinary viewport pick selects its string reference identity without selecting
an IFC entity (`reference-pick.json`).

The library's **Save into model** creates `IfcAnnotation` owner 65 in the loaded
IFC model, with an explicit Name and spatial container. `created.json` records
the selected owner and its texture/UVs. Undo removes the annotation geometry and
clears its selection while retaining the independent reference (`undo.json`);
Redo restores the annotation and its captured image (`redo.json`).

Normal IFC + images export produces an IFCZIP containing the original image
asset. A fresh normal load renders the annotation textured
(`reopen-before-pick.png`). An ordinary viewport pick selects the reopened
`IfcAnnotation` owner 65 (`reopened-selected.png`, `reopened-verified.json`).
The digest-named image is
`f2be22cb22f33a21bd40eab8b3da5c2df4f537841687f58af746413a9c172203`.
The generated IFCZIP is intentionally not committed as a binary test fixture.

These artifacts cover this image/reference/annotation workflow. They do not
claim portable independent-reference image packaging, editing an existing
reference's calibration through the dock, shared-room reference synchronization,
or the later scan reconstruction stages.

Verified source: `8a39083d09ddff0298d006ea942f9723b4ada95c`.
WASM SHA-256: `0ce999541e528f3b7593941f501f483bf87d9d444340328eb37ef8a7ea83d545`.
The final run explicitly asserts Undo clears selection, then exports and freshly
reopens the resulting archive before the ordinary annotation pick.
