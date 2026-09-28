---
"@ifc-lite/collab-server": minor
---

`FsBlobStorage` no longer raises an unhandled rejection when creating its `blobs` directory fails before any method has run (#6286). The failure is still reported: every storage method rethrows it, and the new `whenReady()` resolves once the directory exists or rejects with the `mkdir` error. The reference server entrypoint now awaits `whenReady()` at startup, so a data directory it cannot write fails the boot instead of the first blob request.
