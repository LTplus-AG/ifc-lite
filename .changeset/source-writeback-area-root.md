---
"@ifc-lite/plugin-api": minor
"@ifc-lite/source-dalux": patch
---

Two additions to the write-back contract. `SourceContainer.acceptsUploads` lets a provider say a container cannot take an upload, so a host does not offer it as a destination. `UploadConflict` gains `destination-refused` with a user-facing `reason`, for a destination the provider refuses before writing anything. The Dalux provider lists file areas with `acceptsUploads: false` and answers `new-file` and `new-location` uploads into a file area's root with `destination-refused`, because sending the area id as the root's folder id is unverified against the live Dalux API.
