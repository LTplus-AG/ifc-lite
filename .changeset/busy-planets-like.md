---
"@ifc-lite/renderer": patch
---

Preserve pending GPU picks when viewport synchronization repeats the existing camera aspect ratio. Reject asynchronous picks after actual CSS viewport changes, including proportional resizes that keep the aspect ratio unchanged.
