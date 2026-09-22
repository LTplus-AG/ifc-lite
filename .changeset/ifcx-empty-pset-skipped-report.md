---
"@ifc-lite/export": minor
---

Fix `Ifc5Exporter` (IFCX/IFC5 export) silently dropping a property set with zero properties: `getPropertiesForEntity` only ever wrote by iterating `pset.properties`, so a pset materialized with `properties: []` — a legitimate, deliberately-created state via `MutablePropertyView.createPropertySet(id, name, [])` — left no trace in the output while `stats.propertyCount`/`nodeCount` still reported success. The IFCX wire dialect has no attribute that means "this set exists, with zero members" (the same constraint `apps/viewer/src/lib/layers/publish.ts` hit and resolved under #2277), so the fix is to report the loss rather than invent a representation for it: `Ifc5ExportResult.stats` gains `skippedCount` and `unrepresentedPropertySets`, mirroring `publish.ts`'s `skippedCount`/`unrepresentedOps` naming. A caller must check `skippedCount === 0` before treating an export as a complete, lossless round-trip.
