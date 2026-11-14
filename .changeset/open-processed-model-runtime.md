---
"@ifc-lite/viewer": minor
---

A host can open a server-processed model and name the processing server at runtime. `apps/viewer/src/lib/processed-model.ts` exports `openProcessedModel({ sha256, bytes, name }, { serverUrl? })`, callable before or after the viewer mounts, plus `setProcessingServerUrl` / `getProcessingServerUrl`. The runtime URL replaces `VITE_IFC_SERVER_URL` for every server request, uploads of locally opened IFC files included; whether those uploads happen at all remains the build's `VITE_USE_SERVER` decision. The `?processed=` URL entry now files the same request. A host request wins over `?processed=` and `?model=` in the page URL, also when it was filed before the viewer mounted. A host request filed before the viewer mounts also refuses a collaboration link (`?room=`): the viewer does not join the room, so the room's model cannot replace the host's.
