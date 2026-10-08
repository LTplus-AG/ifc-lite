---
"@ifc-lite/ids": minor
---

`writeIdsXml(doc, fmt?)` takes an `IdsXmlFormat`: `indent` (spaces or a tab), `newline` (`\n` or `\r\n`) and `canonical`, which writes applicability facets in the `ids.xsd` sequence and `ifcVersion` tokens in schema order so the same checks always give the same bytes. Writing is idempotent across the buildingSMART corpus. The writer now also writes every `info` field (copyright, version, author, date, purpose, milestone), writes `IFC4X3` as the IDS 1.0 token `IFC4X3_ADD2`, and refuses a voids-only or fills-only `partOf` relation, which IDS 1.0 cannot express. `parseIDS` recognises the upper-case `ids.xsd` relation tokens (`IFCRELAGGREGATES`, …) and no longer echoes them as `rawRelation`.
