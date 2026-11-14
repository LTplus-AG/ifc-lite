---
"@ifc-lite/viewer": patch
---

Load trace: a cache hit's finalize, its store publish and its UI settle are spans (`load.finalize`, `finalize.identityWait`, `finalize.publish`, `cache.publishStore`, `load.settleUi`), so the time between a reopen's pixels and interactive is attributed. Measurement only.
