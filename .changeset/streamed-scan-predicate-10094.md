---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

`@ifc-lite/geometry/rtc-rebase` exports `isStreamedScanOnly`, the rule the RTC re-base uses for a model it never moves, and `rtcConvergeAction`, which says whether the re-base leaves, refuses or moves a geometry. The viewer now uses the same rule in two more places: a model of inline point clouds is a render frame candidate, and the federation re-base no longer withdraws a streamed scan's spatial index, since the scan never moves (#10094).
