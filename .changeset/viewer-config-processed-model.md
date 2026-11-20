---
"@ifc-lite/viewer": minor
---

The host configuration names the processing server and a model to open. Version 1 gains `server: { url }`, a same-origin path or an `https:` URL (`http:` only from an `http:` page), which overrides `VITE_IFC_SERVER_URL` when present, and `open: { processedModel: { sha256, bytes, name } }`, a model the server already processed that opens as soon as the viewer mounts, without the IFC reaching the browser. With `open` set, `?processed=`, `?model=` and `?room=` in the page URL are ignored. Both members are checked strictly; an invalid one refuses the configuration. `mountViewer` applies them once, after the feature set is fixed, and a requested processed model keeps the browser-side fast path off.
