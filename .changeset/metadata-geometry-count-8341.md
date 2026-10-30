---
"@ifc-lite/server-bin": patch
"@ifc-lite/server-client": patch
---

`POST /api/v1/parse/metadata` now reports `geometry_count` as the number of geometry jobs a default parse of the same file schedules, equal to that parse's `metadata.geometry_entity_count` (#8341). It used to count every record whose class name can carry geometry, so on some files the value goes up:

- A spatial container that is otherwise not geometric (`IfcBuildingStorey`, `IfcFacility`, `IfcFacilityPart` and their subtypes) now counts when it carries a Representation (#1910). Without one it still does not count.
- A type (`IfcWallType`, `IfcDoorType`, …) with no occurrence now counts once per `IfcRepresentationMap` that no `IfcMappedItem` draws (#957). A type with an occurrence, or a map an `IfcMappedItem` draws, does not count.

Ordinary products, including `IfcSite`, `IfcBuilding`, `IfcSpace` and `IfcOpeningElement`, count as before. On a file with neither case the value is unchanged. `entity_count`, `oversized_id_count` and `malformed_record_found` are unchanged. `@ifc-lite/server-client` updates the `MetadataResponse.geometry_count` documentation to match.
