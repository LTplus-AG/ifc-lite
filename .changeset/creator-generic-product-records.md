---
"@ifc-lite/create": minor
"@ifc-lite/sandbox": patch
---

`IfcCreator.addElement` and `addAxisElement` now write each product with its schema's full attribute list. A generic `IfcSpace` gets `LongName`, `CompositionType`, `PredefinedType` and `ElevationWithFlooring` instead of a 7-attribute record. The STEP keyword is always written upper case. Types the generic writers cannot place in a storey correctly are refused with an error instead of producing invalid relationships. That covers groups (`IfcZone`, `IfcSystem`, `IfcGroup`), which are not products, and spatial elements other than `IfcSpace` (`IfcSite`, `IfcBuilding`, `IfcBuildingStorey`, `IfcFacilityPart`, …). A refused type throws before any record is written, and abstract entities are refused too. The sandbox `bim.create.addElement`/`addAxisElement` descriptions now say which types the writers accept.
