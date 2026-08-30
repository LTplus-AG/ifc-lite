---
'@ifc-lite/pointcloud': patch
---

Fix the PLY decoder crushing float-typed vertex colours to near-black. PLY has no single mandated colour encoding: `uchar` (0..255) is by far the most common, but writers that declare `property float red/green/blue` (or `double`) already store a 0..1 value. `decodePly` divided every RGB channel by 255 regardless of its declared type, so an already-normalized `0.8` became `~0.0031`. Colour channels are now normalized per their declared property type: `float`/`double` pass through (clamped to 0..1), integer types (`uchar` and friends) still divide by 255 as before. Both the ascii and binary decode paths were affected.
