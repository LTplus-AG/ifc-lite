---
"@ifc-lite/export": patch
---

Schema conversion writes IfcAsymmetricIShapeProfileDef and IfcTransportElement at the target schema's arity between IFC2X3 and IFC4/IFC4X3 (#10758). Both kept their source layout before, because IFC4 renamed attributes in place and neither attribute list was a prefix of the other. The bottom-flange values carry over under their IFC4 names, and OperationType carries as PredefinedType. Slot 11 of the profile is not carried: CentreOfGravityInY (IFC2X3) and BottomFlangeEdgeRadius (IFC4) are different quantities, so it is written `$` and the conversion loss report names the source attribute.
