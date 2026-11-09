---
"@ifc-lite/renderer": patch
---

`Renderer.getPickGeometryRevision()` now also changes when the point clouds or the source snap curves a magnetic pick snaps to change: a COPC node streaming in or evicted, a scan added, removed, hidden, shown, moved, aligned or relabelled, a class filter change, or a different set of selected-centreline snap curves. A restyle, the same visibility again, or re-installing the same curve set leaves it alone. The viewer's Measure Point "Live" reading now ends when such a change lands under a resting cursor (#9029, #9030).
