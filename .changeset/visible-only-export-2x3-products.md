---
"@ifc-lite/export": patch
---

Stop dropping IFC2X3-only elements from a visible-only export.

`reference-collector`'s `PRODUCT_TYPES` decides which entities become roots of the reference closure under `visibleOnly`. Its doc comment described it as "the complete set of all IfcProduct subtypes", but it was hand-written from IFC4 and IFC4X3 only. Seven concrete IFC2X3 products were absent: `IfcElectricDistributionPoint`, `IfcElectricalElement`, `IfcEquipmentElement`, `IfcChamferEdgeFeature`, `IfcRoundedEdgeFeature`, `IfcStructuralLinearActionVarying` and `IfcStructuralPlanarActionVarying`.

An entity of a missing type matched neither the infrastructure, spatial, `IFCREL*` nor product branch. The `hiddenIds` fallback below them only catches an entity the user explicitly hid, so a **visible** one fell through to "not a root" and never entered the closure — the element and the geometry only it referenced were silently absent from the written file, with no warning. Legacy IFC2X3 MEP models, where `IfcElectricDistributionPoint` carries switchboards and distribution panels, lost that equipment on every `--visible-only` STEP export and on every federated merge export with visibility filtering.

The set is now derived at module load from `@ifc-lite/data`'s generated `ENTITIES_IFC2X3` / `ENTITIES_IFC4` / `ENTITIES_IFC4X3` tables by walking each entity's parent chain to `IfcProduct`, so regenerating the schema tables can no longer leave this classifier behind. IFC4 and IFC4X3 classification is unchanged — the diff that found this reported those two schemas complete.
