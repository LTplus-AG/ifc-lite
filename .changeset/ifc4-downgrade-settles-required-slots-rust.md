---
"@ifc-lite/wasm": patch
---

Fixed a STEP export to IFC4 from IFC4X3 or IFC5, on the Rust side (#5307, the Rust twin of #5202): `convert_step_line` only ever consulted a required-slot table when the target schema was IFC2X3. A downgrade to IFC4 kept `$` in every slot IFC4 declares mandatory that IFC4X3 (or IFC5) left optional -- an IFC4X3 `IfcProjectedCRS('...',$,$,$,$,$,$)` downgraded to IFC4 came out unchanged, with `$` in the mandatory `Name`, which a strict IFC4 reader rejects.

`Ifc4SlotFill` is the IFC4 twin of the existing `Ifc2x3SlotFill` (#4714): a BOOLEAN required slot IFC4X3/IFC5 left `$` is filled with `.F.`, the schema's own "claims nothing" default; every other required slot -- measures, labels, identifiers, entity references, and every enum -- keeps `$` and is COUNTED (`StepStats::ifc4_required_slots_unfilled`, `MergedStats::warnings`), so a caller learns the file is not valid IFC4 rather than receiving a fabricated value. Enum-typed slots are deliberately left unfilled: an invented enum member would be indistinguishable from #5202's separate, still-open enum-reconciliation gap.

Driven by a generated table (`scripts/generate-ifc4-required-slots-rust.mjs`, from the EXPRESS-derived IFC4 schema registry), row-identical to the TypeScript table #5202 generates. `IFC2X3 -> IFC4` is deliberately excluded, matching the scope line #5202 drew: IFC2X3's own mandatory/optional shape was never audited for this table, so applying the fill there risked silently rewriting an already-correct conversion.

Before this fix, the two schema converters disagreed for an IFC4X3/IFC5 -> IFC4 downgrade: TypeScript (#5202) counted and warned, Rust stayed silent. They now apply the same policy.
