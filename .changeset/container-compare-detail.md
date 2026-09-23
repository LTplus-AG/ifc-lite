---
'@ifc-lite/viewer': patch
---

Compare now shows a container-only change. Following up on `diffModels`' `'container'` change kind (#5214/#5311), an element re-parented to a different spatial container with no other signal difference used to badge the row as modified while the detail panel rendered nothing and the CSV/JSON report fell back to the generic "Changed" label. The detail panel now shows the old and new container path, and the report names the change ("Container changed").
