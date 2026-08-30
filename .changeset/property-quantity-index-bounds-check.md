---
'@ifc-lite/cache': patch
---

Fix `readProperties`/`readQuantities` accepting an out-of-range row index from the cached `entityIndex`/`psetIndex`/`propIndex`/`qsetIndex`/`quantityIndex` tables without validation.

Those tables map a key (entity id, pset/qset name index, property/quantity name index) to row indices into the parallel column arrays (`entityId`, `psetName`, `propType`, `value`, ...). The column arrays are fixed-size typed arrays, so an out-of-range row index doesn't throw — `arr[idx]` on a `Uint32Array`/`Float64Array` silently answers `undefined`. A corrupt or hand-crafted cache file whose index table names a row past the column length therefore didn't fail the cache load: `getForEntity` returned a property set (or quantity set) whose set name, property/quantity name and type were all `undefined` — and, for a quantity, whose value was `undefined` too — as if they were real data, and `QuantityTable.sumByType` summed that row into `NaN`, instead of the cache being rejected and the source file re-parsed. `getPropertyValue`/`getQuantityValue` answered `null` for such a row and `findByProperty`/`findByQuantity` skipped it, so those accessors did not surface garbage. `entity-index.ts`'s `typeIndex` bounds check already covered the equivalent condition for the entity index section; this closes the same gap in the property and quantity tables.

Reading a cache file corrupted at the property/quantity index tables now throws `Corrupt cache PropertyTable <indexName>: row index N for key K exceeds row count C` (or the `QuantityTable` equivalent) instead of silently returning garbage rows. This is only reachable via a damaged or hand-crafted cache file, never via a normal write-then-read round trip.
