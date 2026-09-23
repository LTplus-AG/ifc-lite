---
"@ifc-lite/sdk": minor
"@ifc-lite/cli": patch
---

Resolve cost authoring's `IfcOwnerHistory` from the effective entity set, including overlay creations and type changes in the viewer and CLI hosts (#5249). SDK callers may pass the mutation view as a third argument; the two-argument source-only call remains available.
