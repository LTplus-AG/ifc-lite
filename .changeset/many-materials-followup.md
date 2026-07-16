---
"@ifc-lite/parser": minor
"@ifc-lite/ids": patch
---

Material association hardening (follow-up to #1755):

- **Multiple `IfcRelAssociatesMaterial` per element** are no longer lost. New `resolveAllMaterialDefIds` / `extractAllMaterialsOnDemand` surface every association (relationship-graph backed, ordered by rel express id). The single-entry `onDemandMaterialMap` "primary" is now deterministic — the association with the LOWEST rel express id wins — and the viewer cache rebuild applies the same rule, so a cache load can no longer disagree with a fresh parse. Models where the old last-wins rule picked a later association may report a different primary material in single-value surfaces (MCP/CLI/SDK).
- `buildMaterialUsageIndex` lists elements under EVERY associated material, so the By Material tab and per-material totals include secondary associations.
- `extractMaterialPropertiesOnDemand` aggregates `Pset_Material*` across all associations instead of only the primary.
- **IDS**: material facets now check every association — a requirement satisfied only by an element's second association no longer false-fails.
- **Constituent-set fractions**: constituents without an authored `Fraction` receive an equal share of the unallocated remainder instead of weight 0, so they contribute to per-material quantity totals.
