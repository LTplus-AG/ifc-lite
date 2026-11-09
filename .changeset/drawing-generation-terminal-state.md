---
"@ifc-lite/viewer": patch
---

Every 2D drawing generation now ends in a terminal state (#9488). Removing the last model or closing the 2D panel while a cut is still running used to leave the spinner overlay up, Regenerate disabled and BCF capture saying the section was "still generating". It also left BCF capture blocked until some later cut succeeded. The drawing request queue now ends each chain of superseding requests exactly once. If that chain is cancelled, the status returns to ready over the kept drawing, or to idle.
