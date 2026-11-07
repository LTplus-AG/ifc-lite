---
"@ifc-lite/viewer": patch
---

Measure Point "Live" is no longer ended by a capture (IDS/BCF viewpoint export) when the next animation tick renders nothing, and a hover pick no longer reads through the capture's camera or clip: both wait for the first live frame after the capture (#9031).
