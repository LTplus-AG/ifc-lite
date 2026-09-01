---
'@ifc-lite/cli': patch
---

`ifc-lite stats` no longer inflates the material summary and the `unnamedElements`/`duplicateGlobalIds` validation counts with non-physical entities. `bim.query()` with no type filter returns every "product" the SDK tracks, including spatial-structure containers (`IfcProject`/`IfcSite`/`IfcBuilding`/`IfcBuildingStorey`/`IfcSpace` and their infrastructure counterparts), groupings (`IfcZone`/`IfcSystem`/`IfcDistributionSystem`), and 2D/3D drafting annotations (`IfcAnnotation`) — none of which are physical building elements. On the `AC20-FZK-Haus` fixture this reported `unnamedElements: 19` (14 of them unnamed `IfcAnnotation` dimension lines, which never carry a `Name`) when only 5 physical elements actually lacked one. `filterBuildingElements` (`packages/cli/src/commands/stats-aggregation.ts`) now scopes both stats to the same physical-element population `elementCounts` already reports on.
