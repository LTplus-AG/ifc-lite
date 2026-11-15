---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

`@ifc-lite/geometry/rtc-rebase` exports `rtcConvergeAction`, which says whether the RTC re-base leaves, refuses or moves a geometry. The federation re-base now uses it before withdrawing spatial indexes, so a streamed scan, which the re-base never moves, keeps its spatial index (#10094).
