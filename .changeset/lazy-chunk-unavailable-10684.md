---
"@ifc-lite/viewer": patch
---

A lazy-loaded part of the viewer whose file cannot be downloaded (a tab left open across a deploy, or a host that does not serve the asset) no longer blanks the whole app. After the one automatic reload, the missing part renders nothing and the "reload to continue" notice appears. The notice now also appears when the automatic reload for a failed chunk is refused, as it already did for the geometry engine.
