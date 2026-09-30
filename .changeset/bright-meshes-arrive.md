---
"@ifc-lite/viewer": patch
---
Reuse the canonical incremental mesh-owner cache for single-model streams, preserving immutable replacements, content updates, point-cloud owners and federation transitions. Avoid repeatedly copying and filtering already published meshes.
