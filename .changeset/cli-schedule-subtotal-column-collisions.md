---
'@ifc-lite/cli': patch
---

Fix two `ifc-lite schedule` cases where two specs mapping to the same output slot silently dropped one of them.

`--columns` now rejects a duplicate header (e.g. `Area=Qto_WallBaseQuantities.NetArea, Area=Qto_WallBaseQuantities.GrossArea`) with a fatal error naming both colliding `Header=path` specs, consistent with every other malformed `schedule` input. Previously the JSON renderer keyed row objects by header, so the later column silently overwrote the earlier one's value.

`--subtotals` with two aggregations on the same `--columns` header (e.g. `sum:Area,avg:Area`) now renders both values in CSV/Markdown/HTML instead of the second one overwriting the first in that column's cell. The tabular renderers share one `subtotalCells` helper, so when more than one aggregation targets a column its cell becomes `"sum: 30, avg: 15"` (each aggregation's function name and value) rather than picking one; a single aggregation on a column still renders as its plain value, unchanged. JSON already kept both (it keys by the aggregation's full spec) and is unaffected.
