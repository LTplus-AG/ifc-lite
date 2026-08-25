---
'@ifc-lite/export': patch
---

Downgrade export: trim every attribute the newer schema appended, not the 30 in a hand-kept table

The IFC2X3 downgrade path decided how many positional attributes to keep from a
hand-written count map of 30 entity types. 63 IFC4 entity types have an IFC2X3
attribute list that is a strict prefix of their IFC4 one; the map reached 10 of
them and left 53 uncovered, so `IfcWallStandardCase`, `IfcZone`, `IfcGrid`,
`IfcMaterial`, `IfcClassification`, `IfcCostItem` and the whole `IfcQuantity*`
family were written into IFC2X3 output carrying an IFC4-only trailing attribute
— a non-conformant file that strict readers reject. Two of the 30 entries also
disagreed with the schema (`IfcPile` 11 vs 10, `IfcDistributionControlElement`
8 vs 9).

The count is now derived from the bundled buildingSMART tables and guarded the
same way the upconversion padding pass already was: attributes are dropped only
when the target's positional name list is a strict PREFIX of the source's, so
entities that reordered or inserted attributes mid-list (`IfcMaterialProperties`,
`IfcApproval`, `IfcTask`, …) are left untouched rather than truncated into the
wrong slots. The rule now applies to any downgrade, so `IFC4X3 → IFC4` also
drops the five attributes IFC4X3 appended (`IfcAnnotation`, `IfcDerivedUnit`,
`IfcObjectPlacement`, `IfcRelInterferesElements`, `IfcVirtualElement`).
