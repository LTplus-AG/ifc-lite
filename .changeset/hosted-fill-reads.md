---
"@ifc-lite/create": minor
---

Add `hostPlanFrame` and `readHostedFill`: live reads of a host wall's placement frame on its storey and of where an opening (or the door or window filling it) sits in its host (Offset along the wall, Sill), through the mutation overlay. They back the viewer's hosted door, window and opening placement (#6232).

Add `placedBodyExtent`: a product's Body extent in its parent placement's frame (for an opening, its cut in the host's frame, whatever its profile or orientation).
