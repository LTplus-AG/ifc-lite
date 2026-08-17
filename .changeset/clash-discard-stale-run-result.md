---
"@ifc-lite/viewer": patch
---

Fix a clash run that finishes after its models are gone repopulating the result list with inert rows. Both publish sites in `useClash` wrote `setClashResult` unconditionally, so clearing the federation mid-run ("Clear all", "Open file", "Remove model", or a collab peer edit replacing the active model's data store) was undone seconds later by the finishing run — and every restored row did nothing, because focusing one resolves no entity refs. Each run now records the identity of the federation it actually gathered elements from (model ids mapped to their data store) and both sites publish through one guard that drops the result if any of those models is gone or has been replaced. The identity is read off the federation rather than bumped by each teardown, so no enumeration of teardown paths can fall out of date.
