---
"@ifc-lite/viewer": patch
---

While a single model streams in, the viewport no longer copies and re-filters every mesh loaded so far on each new geometry batch. Each batch now costs work only for its own meshes. What renders is unchanged.
