---
"@ifc-lite/viewer": patch
---

Fix "Export Visible Only" ignoring the hierarchy panel's Class tab filter and storey isolation (STEP, IFCX, merged STEP and GLB), and add a single resolver every export path routes through so the three visibility mechanisms (hidden/isolated entities, the class filter + storey isolation, and type-visibility toggles) can no longer drift apart per export format.
