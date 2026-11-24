---
"@ifc-lite/drawing-2d": patch
---

Hidden-line classification now finds where a line goes from hidden to visible by bisecting between the two disagreeing samples, instead of guessing the midpoint. A hidden stretch now ends at the occluder's edge, to within one depth-raster pixel, rather than up to half a sample spacing past it, so wall corners and door frame edges no longer show far over the slab in front of them.
