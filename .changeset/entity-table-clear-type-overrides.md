---
"@ifc-lite/data": minor
"@ifc-lite/viewer": patch
---

Add optional `EntityTable.clearTypeOverrides()`, which drops every display-class override set through `setTypeOverride`. The viewer calls it when clearing edits, so a discarded retype no longer leaves its class behind.
