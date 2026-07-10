---
"@ifc-lite/data": patch
"@ifc-lite/parser": patch
"@ifc-lite/lists": patch
---

Harden the immediate-Container spatial level (#1591 follow-up):

- The spatial hierarchy now records an aggregated-descendant containment walk for ANY spatial container node, not just storeys, via a new optional `SpatialHierarchy.elementToContainer` map (also carried across data-store transport). A part nested through an IfcElementAssembly under an IfcBridgePart / IfcRoadPart / IfcSpatialZone now resolves that container instead of a blank cell. Storey-only `elementToStorey` semantics are unchanged.
- The list engine matches the spatial level string case-insensitively, so a hand-edited / imported list carrying `container` resolves the Container level rather than silently falling back to the storey name. An empty or unrecognised level still defaults to Storey.
