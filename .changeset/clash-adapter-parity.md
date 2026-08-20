---
"@ifc-lite/clash": patch
---

Fix two divergences between `@ifc-lite/clash`'s STEP and IFCX source adapters, found by comparing them side by side.

`adapters/ifcx.ts` had no equivalent of `adapters/step.ts`'s #1464 non-clashable-tag filter: an IFCX-sourced model reproduced the same phantom-clash bug class (openings, spaces, and spatial containers with tessellated geometry becoming ordinary clash candidates) that #1464 fixed for STEP.

`adapters/step.ts` had no equivalent of `adapters/ifcx.ts`'s per-entity mesh coalescing: an entity with more than one mesh representation (e.g. Body + Axis) produced one `ClashElement` per mesh instead of one per entity, and `buildStepExclusions`'s `byExpressId` map silently kept only the last mesh's geometry for that entity.

Both the non-clashable-tag filter and the mesh-coalescing logic now live in one shared module (`adapters/shared.ts`) that both adapters call, instead of two copies that could (and did) drift apart. `elementsFromIfcx`'s `tag` is already the real IFC class code, spelled identically to STEP's `node.type`, so the filter applies verbatim; merged bounds are derived from the merged geometry, so the union is correct without a separate "combine bounds" step.

No existing fixture's clash count changed: the affected code paths (IFCX openings/spaces/containers, STEP multi-mesh entities) had no prior test coverage to regress.
