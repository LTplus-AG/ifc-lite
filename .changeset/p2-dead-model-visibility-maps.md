---
"@ifc-lite/viewer": patch
---

Remove the per-model `hiddenEntitiesByModel` / `isolatedEntitiesByModel` visibility maps and their `*InModel` actions. Nothing wrote them, so they were always empty. Every hide and isolate already goes through the global-id `hiddenEntities` / `isolatedEntities` sets, which cover all federated models. Exports, drawings, BCF capture and the basket no longer consult a channel that could never hide anything.
