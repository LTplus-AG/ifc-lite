---
"@ifc-lite/cli": patch
---

Fix the CLI `stats` command's window-area total to sum every matching quantity, not silently drop to the first.

`sumQuantity` in `stats-aggregation.ts` (introduced when `stats.ts` was refactored to share aggregation logic across window area, floor area and material volumes) has no `break` after adding a match — it sums every `Area`/`GrossArea`/`NetArea` etc. quantity across every quantity set on a ref. The original window-area loop it replaced had a `break` after the first `Area` match inside each quantity set, so the two disagreed whenever a quantity set held more than one same-named quantity.

Kept sum-all rather than adding a first-match flag: a quantity set with two same-named quantities is not valid IFC — `IfcElementQuantity` carries the `UniqueQuantityNames` WHERE rule — so the divergence is only reachable on schema-non-compliant files, and four of the five call sites that fed the old loop already summed every match rather than taking the first.
