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
