---
"@ifc-lite/sdk": minor
"@ifc-lite/sandbox": minor
---

Add `bim.query.matchingActiveFilter()` — returns the entities matching the host's active advanced filter (or `null` when no filter is set). Backed by a new `QueryBackendMethods.entitiesMatchingActiveFilter()`. Lets scripted exports (e.g. the CSV quantity take-off) honour the current filtered view instead of always exporting the whole model (issue #1107).
