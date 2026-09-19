---
"@ifc-lite/charts": minor
---

Add a per-chart source filter (#4946): `ChartSpec.filter` narrows a chart's rows with the same selector syntax and matching path the search Filter tab uses, on top of the dashboard scope. Applicable to `elements`, `clash`, `schedule` and `ids`; refused on `bcf` and `compare` where a row does not stand for one matchable element. `DashboardSpec.version` moves from 1 to 2 (adds the filter, drops the unused `list` scope kind); `migrateDashboardSpec` upgrades a saved version-1 dashboard on load. The dead `ChartScope.list` scaffold (no resolver was ever wired to it) is removed.
