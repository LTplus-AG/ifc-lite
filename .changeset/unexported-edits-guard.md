---
"@ifc-lite/viewer": patch
---

Unexported edits are no longer lost without warning (#5604). While the Export Changes button shows pending changes, closing or reloading the tab makes the browser ask first. Removing a model that has unexported changes from the hierarchy now opens a confirmation that names the model and its change count; a model without changes is still removed at once. A CSV import through the data connector now updates the pending-changes count, so the Export Changes button appears right after the import instead of staying hidden until some other edit.
