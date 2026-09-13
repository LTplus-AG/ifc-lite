---
"@ifc-lite/wasm": major
"@ifc-lite/viewer": patch
---

Three geometry results no longer look like success when they are not. `splitMeshByZones` returns `undefined` for a mesh that encloses no volume (no valid triangles, or a degenerate shell) instead of a split whose `sumErrorRel` is 0 and `remainderFailed` is false, and the viewer's zone export refuses that element rather than publishing it as split. `meshOutline2d` still returns `undefined` for a mesh with no footprint, but throws when the mesh has more than 50 000 projected triangles (the outline was not computed) or when `axis` is not 0, 1 or 2; the viewer already falls back to its TypeScript silhouette on a throw, so drawings are unchanged and the refusal is logged. Inside the engine, a batched opening cut now reports whether it cut or why it was rejected, instead of returning the uncut host for the router to compare against by triangle count and a 0.1 % volume test.

**Migration:** check `splitMeshByZones`'s result for `undefined` before reading it (it is typed `ZoneSplitJs | undefined`) and treat that as "no split". Wrap `meshOutline2d` in `try`/`catch`: it now throws for a mesh over the 50 000-triangle budget and for an `axis` outside 0 to 2, where it used to return `undefined`.
