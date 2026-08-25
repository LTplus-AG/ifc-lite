---
"@ifc-lite/embed-protocol": patch
"@ifc-lite/embed-sdk": patch
---

Embed URL parameters: document which are applied and which are still inert.

`?select=`, `?isolate=`, `?hideTypes=` and `?camera=` are now applied by the
embed viewer (they were parsed and never read). `EmbedUrlParams` and the SDK's
`EmbedOptions` now say so per field, and mark `controls`, `hideAxis` and
`hideScale` as parsed-but-not-implemented instead of leaving them looking
wired. `hideTypes` matches IFC class names case-insensitively, so the
SCREAMING_CASE spelling the SDK documents by example resolves the same as
PascalCase.
