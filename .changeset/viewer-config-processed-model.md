---
"@ifc-lite/viewer": minor
---

The host configuration names the processing server and a model to open. Version 1 gains `server: { url }`, which replaces `VITE_IFC_SERVER_URL`, and `open: { processedModel: { sha256, bytes, name } }`, a model the server already processed that opens as soon as the viewer mounts, without the IFC reaching the browser. Both are checked strictly; an invalid one refuses the configuration like any other member. `mountViewer` applies them once, after the feature set is fixed.
