---
"@ifc-lite/viewer": patch
---

The Bulk property editor's class targets now select exact IFC classes (#5864).

A target matched class names by substring, so "Wall" also edited curtain walls and wall type objects (a value written to a type object reaches every one of its instances), "Stair" edited stair flights, and "Slab" / "Door" edited their type objects. A target now selects its class and that class's schema subtypes only: "Wall" is `IfcWall` plus `IfcWallStandardCase` / `IfcWallElementedCase`, and "Furniture" now also reaches IFC4 `IfcFurniture`, which the old match missed.
