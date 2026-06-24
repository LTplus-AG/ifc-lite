---
"@ifc-lite/renderer": patch
---

Keep small high-aspect elements on the compact camera-fit pose. The linear-infrastructure fit policy (camera positioned inside the bbox looking down the longest axis) is meant for railway / road alignments hundreds of metres long, but it triggered on any high-aspect bounding box regardless of absolute size. A single reinforcing bar viewed alone (e.g. a 4.86 m bar, aspect ~130:1) got framed end-on from inside its own bounding box and rendered as nothing (issue #1350). The linear policy now requires the longest axis to be at least 100 m; below that the compact SE-isometric pose frames the whole element. Fixes the rendering half of #1350.
