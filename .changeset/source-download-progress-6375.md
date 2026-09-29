---
"@ifc-lite/plugin-api": minor
"@ifc-lite/source-dropbox": minor
"@ifc-lite/source-msgraph": minor
"@ifc-lite/source-dalux": minor
"@ifc-lite/source-fixture": minor
---

Report download progress from the Dropbox, OneDrive/SharePoint and Dalux providers. `@ifc-lite/plugin-api` gains `readWithProgress(response, onProgress, fallbackTotal)`, which streams a response body and calls `DownloadOptions.onProgress` about ten times a second, starting at `(0, total)` and ending at `(byteLength, byteLength)`. When `Content-Length` is missing, the total falls back to the file's listed size. The `@ifc-lite/source-fixture` conformance suite now checks that a provider's download progress only increases and ends at the byte length.
