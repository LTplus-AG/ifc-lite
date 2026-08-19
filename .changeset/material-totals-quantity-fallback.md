---
'@ifc-lite/viewer': patch
---

Fix the material totals panel dropping area/weight for vendor-named quantities.

`MaterialTotalsPanel`'s `pickQuantity` docstring promised "pick a quantity
value by candidate names (case-insensitive), else by type," but only the
volume total implemented the else-by-type fallback. An element whose only
area (or weight) quantity used a name outside the IFC-standard candidate
list — a vendor-specific `PerimeterArea` or `TopArea`, say — contributed
zero to that material's area/weight total and its row stayed hidden, while
the identical situation for volume was counted correctly.

`pickQuantity` now applies the else-by-type fallback uniformly to volume,
area and weight, picking the alphabetically-first named quantity of that
type when nothing matches a candidate name — a deterministic tiebreak,
rather than depending on the qset scan order the previous volume-only
fallback relied on. The per-element map-building + pick logic that all
three totals shared is now a single extracted function instead of three
call sites that could (and did) drift apart.

Follow-up fix: the alphabetical fallback could select `CrossSectionArea` —
a beam/column/member's section (profile) property, not a surface extent —
as the element's Area, because no candidate name matched it and it sorts
before every real surface-area name those elements carry
(`GrossSurfaceArea`, `NetSurfaceArea`, `OuterSurfaceArea`). Proven on the
app's own shipped `infra-bridge.ifc` sample, this reported a bridge beam's
0.12 m² cross-section as its material area instead of leaving the total
unset. `AREA_CANDIDATES` now recognises the standard surface-area names by
name (so standard beams/columns resolve without reaching the fallback at
all), and the fallback itself excludes `crosssectionarea` so it can never
be picked even as a last resort — degrading to "no value" rather than a
wrong one when it's the only area quantity present.
