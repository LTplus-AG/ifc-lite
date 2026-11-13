---
"@ifc-lite/mutations": minor
"@ifc-lite/create": patch
"@ifc-lite/parser": patch
"@ifc-lite/export": patch
---

Keep per-operation authoring cost independent of session size. Read-only borrows (`readNewEntity`, `readNewEntities`, `readNewEntitiesOfType`, `getNewEntitiesReferencing`) now return frozen copies, so a write through one throws instead of silently bypassing the reference index. Inside a transaction they read unmodified rows without copying them into the draft. New `hasNewEntity` and `getNewEntityCount` answer without reading payloads. The express-id watermark is computed once per store. The effective entity index reads created rows on demand. Re-mesh context roots find created relationships through the reference index. Copy batches resolve each source's storey once. Effective metadata reads borrow rows and use one schema-name snapshot per overlay revision.
