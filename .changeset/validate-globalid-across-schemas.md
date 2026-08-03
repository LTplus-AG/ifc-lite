---
'@ifc-lite/cli': minor
---

**validate**: the GlobalId-uniqueness rule now covers every `IfcRoot` subtype in the file, not only the ones the IFC4 codegen pin carries (issue [#2003](https://github.com/LTplus-AG/ifc-lite/issues/2003)).

The rule skips any type whose inheritance chain does not reach `IfcRoot`, and it read that chain from `getInheritanceChainForEntity`, which is generated from IFC4_ADD2_TC1 and answers an **empty** chain for any class that pin does not carry. Empty means no `IfcRoot`, so those types were skipped — 39 IFC2X3 classes (`IfcScheduleTimeControl`, `IfcSpaceProgram`, `IfcServiceLife`, `IfcMove`, `IfcOrderAction`, `IfcTimeSeriesSchedule`, `IfcConditionCriterion`, …), 80 IFC4X3 ones (`IfcCourse`, `IfcBorehole`, `IfcEarthworksCut`, …) and 4 post-ADD2 IFC4 ones (`IfcAlignment`, `IfcReferent`, `IfcPositioningElement`, `IfcLinearPositioningElement`).

Nothing in the output said so. A file whose only duplicate GlobalId sat on one of those classes was reported as having none, which is worse than an error: the user got a pass the file did not earn. The chain now comes from `getInheritanceChainAcrossSchemas`, the same union walk (IFC2X3 + IFC4 + IFC4X3) the columnar parser has always used, so `validate` can report duplicates on those files that it previously missed — and the reported count on an affected file goes up.

Over all 776 classes the pin does carry, the two lookups agree on every `IfcRoot` / `IfcObjectDefinition` verdict and on the leaf's own name, so **no IFC4 file changes behaviour**. Entities that are not `IfcRoot` subtypes stay excluded, which is what stops two same-named `IfcMaterial`s from being reported as a duplicate: the columnar parser fills its GlobalId column positionally and slot 0 of a resource record is a Name.
