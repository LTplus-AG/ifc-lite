---
"@ifc-lite/wasm": patch
---

Stop merged STEP export from leaving duplicate GlobalIds on IFC4.3 stratum entities.

`export_merged` reconciles GlobalIds so that two federated models sharing an element emit that element's 22-character id once, not twice — a duplicate GlobalId is an IFC spec violation. Deciding whether a line's first attribute *is* a GlobalId means asking whether the entity type derives from `IfcRoot`, and the Rust side asked with a bare `IfcType::from_str`.

The generated enum is derived from IFC4X3 alone and models the three stratum leaves only by their abstract base: `IfcSolidStratum`, `IfcVoidStratum` and `IfcWaterStratum` are all folded into `IfcGeotechnicalStratum`. `from_str` therefore answered `Unknown` for the names authoring tools actually write, and `Unknown` is a subtype of nothing, so reconciliation skipped them. Merging two infrastructure models that share a terrain or soil layer produced a file with the same GlobalId twice — while the `IfcWall` on the next line was reconciled correctly. The lookup now goes through `legacy_aware_ifc_type`, the same resolution every other classifying pass in the workspace is required to use.

The JS classifier in `@ifc-lite/export` never had the bug: it resolves those names through `ENTITY_NAME_ALIASES`, the mirror of `rust/core/src/legacy_entities.rs`, and answered rooted all along. So this was a live cross-language disagreement, and both halves of the parity gate added in #3015 were green throughout — because the sweep's universe was built from Rust's own two tables, and a name known only to an alias table appears in neither. A universe that cannot name a type cannot compare it.

Two structural changes close that, rather than three rows being added by hand. The sweep's universe now includes `ifc_lite_core::LEGACY_ENTITY_NAMES`, a newly enumerable form of the legacy table whose contents are re-derived from the lookup's own source text and asserted equal, so an arm added without a name fails the test. And `rooted_type_parity.rs` now asserts WHICH rows the fixture holds, not just how many: previously 31 rows could be deleted — including the three the unit tests call load-bearing — and both languages stayed green on the remainder at `901 > 900`, so a disagreement could be made to disappear by deleting the row that carried it.

Measured across the whole 936-name universe, Rust and JS disagreed on 3 names before and 0 after.
