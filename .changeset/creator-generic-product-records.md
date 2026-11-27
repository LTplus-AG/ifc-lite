---
"@ifc-lite/create": minor
"@ifc-lite/sandbox": minor
---

`IfcCreator.addElement` and `addAxisElement` now write each product with its schema's full attribute list. A generic `IfcSpace` gets `LongName`, `CompositionType`, `PredefinedType` and `ElevationWithFlooring` instead of a 7-attribute record. The STEP keyword is always written upper case. Types the generic writers cannot place in a storey correctly are refused with an error instead of producing invalid relationships. That covers groups (`IfcZone`, `IfcSystem`, `IfcGroup`), which are not products, and spatial elements other than `IfcSpace` (`IfcSite`, `IfcBuilding`, `IfcBuildingStorey`, `IfcFacilityPart`, …). Abstract entities, feature elements (`IfcOpeningElement`), types the target schema does not define and `USERDEFINED` without an `ObjectType` are refused too, and every refusal throws before any record is written. The sandbox `bim.create.addElement`/`addAxisElement` pass these refusals through to scripts, and their descriptions say which types the writers accept.
