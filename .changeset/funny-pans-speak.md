---
"@ifc-lite/renderer": patch
---
Restore CPU-backed streaming fragments after device loss before resuming the existing pending queue. Keep replacement devices private until restoration commits, reject changed source ownership, and record opt-in categorical recovery outcomes.
