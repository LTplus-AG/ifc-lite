---
"@ifc-lite/rules": minor
---

`ruleSetToIds` now serialises through `writeIdsXml` from `@ifc-lite/ids` (#6915, ADR-005), so its export also writes property `dataType`, `partOf` facets (upper-case XSD relation token, related entity required) and requirement `instructions`. `@ifc-lite/rules` does not export the writer itself: import `writeIdsXml` from `@ifc-lite/ids`.
