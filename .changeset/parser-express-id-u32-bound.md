---
'@ifc-lite/parser': major
---

Refuse an express id above 4294967295 at the parse boundary instead of letting it truncate into a real entity's key (#3395).

**BREAKING**, in two ways a consumer can hit. `EntityScanResult` gains a REQUIRED `oversizedIdCount: number`, so anything that constructs one against the exported shape (a test double, a custom scanner adapter) stops compiling until it supplies the field; code that only reads the result of `scanIfcEntities` is unaffected. And `CompactEntityIndexBuilder.add` / `buildCompactEntityIndex` / `buildCompactEntityIndexAsync` now throw a `RangeError` on an id outside `[0, 4294967295]` where they previously narrowed it, so a caller that fed one an out-of-contract id and got a corrupt index back now gets an exception instead. The required field is what makes this a major rather than a minor: the old narrowing was silent corruption rather than a contract anyone could depend on, but the type was not corrupt before.

Express ids have a de-facto 32-bit representation contract. `CompactEntityIndex`, the entity/property/quantity tables, the relationship graph, the data-store transport columns, the wasm boundary and the Rust core all store them as `u32`, but nothing enforced it on the way in. Every parse-boundary guard tested `Number.isSafeInteger`, which admits ids up to 2^53, so `#4294967297` was accepted and then stored as `4294967297 % 2^32 = 1`: the index held a duplicate key `1` serving the oversized record's byte range and type, and because the narrowing happened after the ids were sorted, the entry also landed out of order and broke the sorted invariant `binarySearch` relies on. Measured on a three-record file, `store.entities.getGlobalId(1)` returned the oversized record's GlobalId.

The bound now lives in one place (`isIndexableExpressId`) and every admission and reference site routes through it: both `StepTokenizer` scans, the inline scan worker, `EntityExtractor`, `getReference`, and the byte-level `readRefId`. `#4294967295` (`u32::MAX`) is still admitted, and negative ids are refused for the same reason a large one is: `new Uint32Array(1)[0] = -1` reads back as 4294967295.

Refusals are counted and reported rather than dropped silently. `StepTokenizer.oversizedIdCount` and the new `EntityScanResult.oversizedIdCount` carry the count, and `scanIfcEntities` emits an `onDiagnostic` message plus a `console.warn` when it is nonzero. The count is one per refused *record*, matching Rust's `EntityScanner`: both TypeScript scans test the bound only once `#<digits>[ws]*=` has matched, because an accepted record is left behind by skipping to its `;` while a refused one is not, so the scan walks the refused record's argument list — where `#4294967297=IFCWALL(#4294967298,#4294967299,…)` would otherwise be reported as three skipped records for the one that was dropped. Behaviour change for pathological files: a record with an out-of-contract id now visibly disappears from the load instead of silently corrupting the index. `CompactEntityIndexBuilder.add` and `buildCompactEntityIndex`/`buildCompactEntityIndexAsync` now throw a `RangeError` naming the id rather than narrowing it, so a future path that forgets the boundary guard fails where the mistake is.

This supersedes the `Float64Array` id buffer added to the inline scan worker in #3330: with the tighter bound the widening carried ids no consumer could hold, so the buffer is back to `Uint32Array`.

## Migrating

- Constructing an `EntityScanResult` by hand: add `oversizedIdCount: 0`. Reading one needs no change, and the new field is the count of records the scan refused.
- Feeding `CompactEntityIndexBuilder.add` or `buildCompactEntityIndex`/`buildCompactEntityIndexAsync` from refs ifc-lite did not scan: bound the ids first, or catch the `RangeError`. Refs from `StepTokenizer`/`scanIfcEntities` are already bounded, and so is any `Uint32Array` id column, so neither of this repository's two non-scan call sites can reach the throw.
