---
"@ifc-lite/viewer": patch
---

A section plane no longer appears on every model you open ([#6374](https://github.com/LTplus-AG/ifc-lite/issues/6374)). Since section cuts became lasting scene state, the translucent plane the Section tool shows while you aim a cut was also drawn whenever no cut was active: on a freshly opened file, and after the section chip's "Forget this cut" (X) button. Nothing could hide it, because the chip's hide button only exists while a cut is on. That preview is now drawn only while the Section tool is open, as before. An active cut still stays on screen when you switch tools, and the chip still hides it.
