---
"@ifc-lite/renderer": patch
---

Fix lens / Pset colour rules silently failing on IfcSpace, IfcOpeningElement, and other transparent-by-default entity types (issue #677).

The lens system paints colour overrides through a second pass whose pipeline uses `depthCompare: 'equal'`, so it only paints where the base draw already wrote depth. The transparent pipeline runs with `depthWriteEnabled: false`, so any colour rule targeting an entity that defaults to transparent (IfcSpace alpha 0.3, IfcOpeningElement alpha 0.4, glass, …) was silently dropped — the equality test never matched and the chosen colour never appeared.

The renderer now consults `scene.getColorOverrides()` when classifying meshes and batches for the opaque-vs-transparent pipeline split. Meshes whose `expressId` carries an override at alpha ≥ 0.2 are promoted to the opaque pipeline so the base draw writes depth, and the overlay paint pass then paints the chosen colour on top. Ghost-tier auto-fades (alpha 0.15) are deliberately left in the transparent path to preserve existing fade behaviour for unmatched entities.

Pure routing logic lives in a new `overlay-routing.ts` helper that's unit-tested without a GPU device.
