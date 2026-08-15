---
"@ifc-lite/viewer": patch
---

Fix: formatDistance() now honors unitDisplayOverrides from the Properties panel (issue #2199). When a user sets feet or another display unit in the Properties panel, the measure tool now displays distances in that unit instead of always using metres.
