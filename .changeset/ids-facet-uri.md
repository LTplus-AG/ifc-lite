---
"@ifc-lite/ids": minor
---

`parseIDS` now reads the IDS 1.0 `@uri` of property, classification and material facets in requirements (blank values are dropped), so a bSDD class or property reference survives a default parse/`writeIdsXml` round trip. In applicability `@uri` stays an IDS 1.1 preview feature, read and written only with `preview: { ids11: true }`.
