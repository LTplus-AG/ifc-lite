---
"@ifc-lite/viewer": patch
---

Duplicating an element in a non-active federated model now sizes the copy's offset from that element's own bounds. `duplicateEntity` resolved the source globalId against its own model but looked the meshes up in the top-level `geometryResult`, which mirrors the *active* model — so the bounds came back empty, the offset silently collapsed to the 1 m fallback step, and the copy got no visible mesh. Mesh lookups in `mutationSlice` now go through a single helper that reads the edited model's own geometry and only falls back to the top-level mirror for the model that mirror actually represents (#4929).
