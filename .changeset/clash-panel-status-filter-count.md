---
'@ifc-lite/viewer': patch
---

Fix the clash panel's header count silently disowning the review-status filter: unticking `resolved` or `accepted` in the status chips shrank the rendered list without touching the big headline number or the severity bar underneath it, so the panel could read e.g. "88 clashes" while only 81 rows were actually on screen. The header already reconciled correctly for the "Hide touching" filter (appending "· N shown"); it now does the same whenever ANY active filter — touching or status — drops a row, instead of checking `hideTouching` alone.
