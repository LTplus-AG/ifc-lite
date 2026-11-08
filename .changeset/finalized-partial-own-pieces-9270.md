---
"@ifc-lite/renderer": patch
---

Hiding or isolating an entity while a model keeps streaming after a finalize no longer draws some of its pieces twice. A finalized batch keeps drawing until the next finalize replaces it, and its partial batch used to take every piece of its colour bucket, including pieces in newer streaming fragments that those fragments already draw, so translucent entities showed double blending. The partial batch of such a batch now draws only the pieces it holds, the way a streaming fragment's partial does since #9185. This applies after a placement edit finalizes mid-stream, and to geometry that streams in while a time-sliced finalize runs. While that finalize runs, the old batch also keeps drawing a piece the regroup moved to another colour bucket, and X-Ray and override promotion split it per entity.

Geometry that streams into a colour group while a time-sliced finalize has not yet rebuilt it is no longer drawn twice once that finalize completes: the rebuilt batch leaves it to the streaming fragment already drawing it, and the next finalize takes it in. A colour-merged mesh streamed beside a finalized batch no longer stops X-Ray and override promotion from splitting that batch per entity.
