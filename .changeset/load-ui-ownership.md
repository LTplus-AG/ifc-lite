---
"@ifc-lite/viewer": patch
---

Paths that never own a model load no longer reset another load's loading card. Draping a georeferenced image while a model was still streaming ended that model's spinner and re-enabled picking mid-stream; it now leaves a streaming load's spinner up (that load's progress bar can still restart from 0% until its next update). A federated add refused by the retained kernel no longer leaves the viewer stuck at "Loading file 0%" with no Cancel. Cancelling a federated add no longer clears an error (and its Retry) that another load reported meanwhile.
