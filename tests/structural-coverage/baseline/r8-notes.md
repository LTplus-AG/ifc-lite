# R8 harness correction measurement

Product source: main `80f01cc596cd541237c8083f7b17b9e62b068f44` (includes #10530). No product changes in this revision. R8 corrects the measurement; it is not a product climb round. R0 to R7 are retained.

Rows: **104.5/119 -> 106/119** (met 90 -> 93, partial 29 -> 26, missing 0 -> 0). Cells: **750.5/774 -> 755.5/774**. Read: 106.5/110 -> 109.5/110; card: 97.5/100 -> 99.5/100. All other level totals are unchanged. Both online ratchet runs (against R7, then R8) pass with no row or cell dropped.

## Every changed cell

The full summary comparison has exactly these six changed cells, including reason-only and evidence changes (there are no additional ones).

| Row | Level | R7 -> R8 | Why |
|---|---|---|---|
| IFC2X3/IfcStructuralLoadLinearForce | read | partial -> pass | Index each activity's `subsequentLoads` through the existing recursive load indexer. All 131 previously omitted records (of 263) already exist in the product read model with matching components, including AxisVM #7359 referenced by #7360. |
| IFC4X3/IfcRelConnectsStructuralActivity | read | partial -> pass | Accept the extractor's normalized activity/item pair in either STEP orientation, requiring the activity's `appliesToGlobalId` to name the item and, when that end is a structural item in the STEP file, the item's `activityGlobalIds` to name the activity. A physical IfcElement end is not in the structural read model and is exempt. Portal relations #89 and #92 reverse the endpoints; all 20 links now receive credit. |
| IFC4/IfcSurfaceReinforcementArea | read | fail -> pass | Product fix #10530 already on main exposes the standalone reinforcement result; this passes even with the original read probe. |
| IFC4/IfcSurfaceReinforcementArea | card | fail -> pass | Product fix #10530 already on main exposes the reinforcement card data; no card probe change. |
| IFC4X3/IfcSurfaceReinforcementArea | read | fail -> pass | Product fix #10530 already on main exposes the standalone reinforcement result; this passes even with the original read probe. |
| IFC4X3/IfcSurfaceReinforcementArea | card | fail -> pass | Product fix #10530 already on main exposes the reinforcement card data; no card probe change. |

The same product source and complete, checksum-verified corpus scored 105/119 rows and 754.5/774 cells with the original probes. The two probe fixes account for the remaining +1 row point and +1 cell point; the four reinforcement cells account for the earlier-main improvement over R7.

## Regression evidence

`node --test scripts/structural-read-observation.test.mjs` against the original `read.mjs`: four existing tests pass, both new tests fail (`fail` where `pass` is expected). Against the corrected probe: all six pass.

- `#9668 read indexes subsequent loads recursively and still rejects wrong or missing values`: checks direct subsequent loads and configuration descendants, with wrong-value and absent-load controls.
- `#9668 read accepts normalized activity links in either STEP orientation and rejects unrelated ends`: checks both orientations, with wrong-target, absent-activity, item-end-missing-link dropped-structural-item and dangling-reference controls, plus a physical-element end that passes.

Tests exercise the probe's observable verdicts using stated invariants and schema-positioned STEP records; no product source or fixture was changed.
