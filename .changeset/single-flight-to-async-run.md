---
"@ifc-lite/viewer": patch
---

A clash reconciliation in the BCF drafts dialog that fails to apply now says so in the panel. Previously the failure only raised the general "report this error" invitation. The BCF, clash, compare, layer-review and review actions that refuse a double press now run on one shared async-run hook. Closing a form or switching batches still discards an action in flight, and now also signals it to stop.
