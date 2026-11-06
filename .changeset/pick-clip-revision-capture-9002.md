---
"@ifc-lite/renderer": patch
---

A capture render (`restoreEvictedForCapture`) no longer leaves `getPickClipRevision()` moved. The capture frame still gets its own revision, because a pick made before the next frame reads through the capture's clip. When the next normal frame shows the same clip as before the capture, the revision returns to its earlier value, so a Live reading under a section survives an IDS or BCF viewpoint export. A real clip change around a capture still moves the revision.
