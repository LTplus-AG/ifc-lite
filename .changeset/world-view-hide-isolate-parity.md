---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

3D World Context now hides what you hide: hide and isolate reach the map, not just the viewport.

The world view renders the model through its own glTF pipeline, so it never inherited the per-frame hide/isolate filtering the WebGPU renderer applies. It honoured type visibility (its mesh list arrives pre-filtered) but nothing else — hide an element, or isolate a storey, and the map kept drawing everything. Since #2576 gave the world view the GPU-instanced half of the model as well, that gap covered both geometry channels.

`@ifc-lite/renderer` now exports the rule itself rather than leaving each surface to restate it. `isEntityVisible(expressId, hiddenIds, isolatedIds)` was written out separately at the flat-draw and instanced-draw sites; both now call the shared helper, and so does the world view. `VisibilityEpochTracker` — already used internally for content-based change detection on those two sets — is exported alongside it, so a consumer outside the render loop can tell a real visibility change from a store handing out a fresh Set with identical content.

Two details the shared rule pins down, both easy to get wrong when restating it: an EMPTY isolation set isolates *nothing* (it hides everything) and is not the same as `null` (no isolation), and hiding wins over isolation.
