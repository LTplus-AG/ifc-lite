---
"@ifc-lite/renderer": patch
---

Reject point and rectangle selection while the camera is outside the supported coordinate envelope, including readbacks that complete after camera invalidation. Picking resumes when the camera returns to a supported pose.
