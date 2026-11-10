---
"@ifc-lite/create": minor
---

`IfcCreator` accepts `FileName` and `FileDescription` project options for the STEP header's `FILE_NAME.name` and `FILE_DESCRIPTION.description` (one string or several list entries). Without them the header is unchanged (`'created.ifc'`, `'Created by ifc-lite'`). Values longer than the 256 characters ISO 10303-21 allows, and an empty description list, are rejected.
