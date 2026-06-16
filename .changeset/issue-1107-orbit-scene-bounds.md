---
"@ifc-lite/renderer": patch
---

Add `Camera.getSceneBounds()` — an O(1) accessor for the cached scene bounds (the value last passed to `setSceneBounds`). The viewer uses it to anchor the orbit pivot to the scene centre on a raycast miss / large model, instead of the drifting camera target which made repeated rotation feel untethered (issue #1107).
