---
"@ifc-lite/create": patch
---

Auto Spaces: a wall created in this session now bounds rooms only on the storey it is contained in (#5642). `extractWallSegmentsForStorey` used to add every overlay-created divider to whichever storey was being processed, so a wall authored on one storey split rooms on every storey. Created dividers now come from the same spatial walk as source ones: a created divider with no `IfcRelContainedInSpatialStructure` (for example a raw `IfcWall` added through a generic entity-create tool) no longer bounds any storey, and the extraction's `considered` count no longer counts created walls twice.
