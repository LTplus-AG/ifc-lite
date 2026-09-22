---
'@ifc-lite/mutations': minor
---

`CsvConnector` matches on `tag`, and `property` is implemented (#5167).

The `property` strategy was previously declared but warned "not yet implemented" and matched nothing. It now resolves through the mutation overlay and considers every property set sharing a name, so an entity carrying both a type and an occurrence pset of the same name matches on either. A new `tag` strategy joins on the element `Tag`.

Matching builds one index per call instead of scanning every entity per row, and reports ambiguous matches, empty match cells, and a match column missing from the CSV header.
