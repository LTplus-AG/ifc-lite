---
"@ifc-lite/collab": minor
"@ifc-lite/parser": minor
---

Preserve per-model spatial metadata in collaboration rooms and allow reconstructed stores to retain pre-extracted georeferencing through worker transport. Synchronize subsequent georeference edits through the same room metadata and expose the canonical computeTransformMatrix helper to keep derived transforms coherent. Older rooms remain readable without fabricated coordinate offsets.
