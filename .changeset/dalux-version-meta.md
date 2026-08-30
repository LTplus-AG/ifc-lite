---
'@ifc-lite/source-dalux': patch
---

`toSourceFile` now forwards Dalux's `version` field into `SourceFile.meta.version`. `decodeFile` already decoded it, but the mapper dropped it before it reached the `SourceFile` the host consumes — unlike `fileType`/`fileSize`/`lastModified`, which all reach the produced `SourceFile`, or `fileAreaId`/`folderId`, which already flow through the same `meta` bag. `SourceFile.meta` is documented as the provider-specific pass-through channel, and Dalux has no revision-history API to carry a version label through `SourceRevision` the way the msgraph/SharePoint provider does, so `meta` is the only place this value can reach a consumer.
