---
"@ifc-lite/wasm": minor
---

Add reviewable face masks to opted-in evaluated occurrence appearance planning (`AppearanceRequest.faceMasks`). Every conversion now reports a `surfaceFingerprint` for its evaluated surface at its current placement (express ids excluded, so a renumbered export keeps a mask; a placement edit generally reports it stale); a mask bound to that fingerprint splits the authored Body into a textured `IfcTriangulatedFaceSet` and a retained face set that keeps the source style, under the same wrapper. A mask whose surface changed is an explicit `Face selection is stale` exclusion, never a silent reuse of triangle ordinals. The evaluated policy also accepts any uniquely owned Body whose representation type permits tessellation (SweptSolid, Brep, CSG, Clipping and similar), including a solid Body a type's representation map references, instead of mapped occurrences only.
