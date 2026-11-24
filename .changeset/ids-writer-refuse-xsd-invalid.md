---
"@ifc-lite/ids": patch
---

`writeIdsXml` refuses facet shapes `ids.xsd` 1.0 cannot carry instead of writing a file other tools reject: an optional `partOf` requirement, a classification with neither value nor system, and a prohibited or optional entity requirement (entity has no cardinality, so it was silently written as required).
