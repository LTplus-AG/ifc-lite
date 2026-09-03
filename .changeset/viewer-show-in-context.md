---
'@ifc-lite/viewer': minor
---

New "Show in context" action in the Properties panel header (#3618): fades every other entity translucent and frames the camera on the selected one, so an object behind other geometry stays visible in its surroundings instead of being isolated away from them.

It preserves an active isolation rather than discarding it, and tears its own fade down when the panel closes, so a fade can never outlive the only control able to clear it.
