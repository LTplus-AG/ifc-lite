---
"@ifc-lite/viewer": patch
---

`placementFrameKey` now includes the current RTC anchor for a non-georeferenced workspace, so a federation convergence (#4897/#4906) that shifts every model's render-frame origin by the same delta produces a distinct key. A rotation pivot saved before a convergence is a workspace point captured in the frame it was recorded in; before this change the key stayed the fixed `local-engineering:m:z-up` string across a convergence, so restoring a saved placement afterward rotated the model about a point that had moved by the full RTC delta. A manifest import across a convergence is now refused with "The placement coordinate frame differs from this workspace." instead of silently reused, and a localStorage restore finds nothing under the moved frame's key (#4936).
