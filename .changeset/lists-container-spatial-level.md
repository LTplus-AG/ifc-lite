---
"@ifc-lite/lists": patch
---

Add a `Container` spatial level: a `spatial` column or condition with `propertyName: 'Container'` resolves the element's IMMEDIATE spatial container (its direct IfcRelContainedInSpatialStructure parent - the storey, or for infrastructure the IfcBridgePart / IfcRoadPart / IfcSpatialZone it sits in) via the new optional `ListDataProvider.getContainerName`. Providers without the method keep returning blank cells; existing levels (`Storey` default, `Building`, `Site`, `Project`) are unchanged.
