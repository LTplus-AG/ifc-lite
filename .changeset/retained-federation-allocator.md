---
"@ifc-lite/renderer": patch
---

Reserve space for a retained edit allocator when registering a replacement model, so shrinking a source can keep the model editable without reusing earlier entity IDs.
