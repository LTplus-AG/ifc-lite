---
"@ifc-lite/bcf": patch
---

BCF 3.0 writer no longer emits an empty `<Comment>` text or empty `<Label>`, which the official markup.xsd rejects (both are non-empty strings but optional elements). A viewpoint-only comment is written without a text element and keeps its viewpoint reference; blank labels are dropped. BCF 2.1 output is unchanged.
