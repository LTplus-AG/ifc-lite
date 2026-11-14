---
"@ifc-lite/drawing-2d": patch
---

Hidden-line classification now finds where a line goes from hidden to visible by bisecting between the two disagreeing samples, instead of guessing the midpoint. A hidden stretch ends at the occluder's edge rather than up to half a sample spacing past it, so wall corners and door frame edges no longer show over the slab in front of them.
