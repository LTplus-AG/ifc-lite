---
"@ifc-lite/create": minor
"@ifc-lite/viewer": patch
---

A profiled beam, column or member that the wasm re-mesh leaves without a mesh now falls back to a box the size of its section's bounding box. Before, it was drawn from its missing `Width`/`Height`. `@ifc-lite/create` exports `profileSectionExtent` for this (#6232).
