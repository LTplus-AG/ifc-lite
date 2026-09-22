---
'@ifc-lite/charts': minor
---

Add Element Count chart type. Displays the total count of elements as a numeric KPI-style readout. The chart reuses the existing source-filter mechanism and renders a single aggregated value as text.

`ChartSpec` is now a discriminated union on `type`: every chart type but `elementCount` still requires `dimension`, and `elementCount` must omit it entirely (no `dimension: ''` sentinel). `aggregate()` always counts matching rows for `elementCount` regardless of `measure`, and `validateDashboardSpec()` rejects an `elementCount` chart that carries a `dimension` or a non-`count` measure, so a chart switched from a sum-measured type can no longer render a stale total of zero.
