---
"@ifc-lite/export": minor
---

Add `serializeEntitySubgraph` and `remeshContextRoots` (#6232). They write a small, self-contained STEP file holding a few elements and everything the mesher needs to rebuild them: each element's forward references, the project's units and representation contexts, its openings and the openings' fillings (with their `IfcRelVoidsElement` / `IfcRelFillsElement`), and its `IfcRelAssociatesMaterial`. Shared relationships are narrowed to what the file holds. The cost scales with the elements' own reference closure rather than the model, so this can run on every authoring commit. Queued edits and overlay-created entities are written exactly as the STEP exporter writes them, express ids are preserved, and styles are left out. Meshing a wall from its subgraph produces the same positions and indices as meshing it inside the whole file.
