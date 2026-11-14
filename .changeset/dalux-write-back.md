---
"@ifc-lite/source-dalux": minor
---

The Dalux provider implements `uploadFile` and declares `writeBack: ['new-version', 'new-file', 'new-location']`. It uses Dalux's three-step upload (slot, 4 MiB parts with `Content-Range`, the most the same-origin relay accepts, finalize with `fileId` for a new revision or `folderId` for a new file). It reports `stale-base` and `name-exists` conflicts before sending any bytes, refuses published and shared file areas, refuses folders that require file properties, and carries a file's existing properties onto its new revision. In the browser it needs the relay's upload routes (#9524). Part of #9522.
