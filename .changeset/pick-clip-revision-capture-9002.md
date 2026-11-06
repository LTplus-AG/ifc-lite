---
"@ifc-lite/renderer": patch
---

A capture render (`restoreEvictedForCapture`) no longer moves `getPickClipRevision()`. A capture that clears or swaps the clip is restored by the next normal frame, so a Live reading under a section survives an IDS or BCF viewpoint export. A real clip change around a capture still moves the revision.
