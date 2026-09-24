---
"@ifc-lite/mutations": minor
"@ifc-lite/viewer": patch
---

Bulk edits and CSV imports are now one undo step each (#5861).

The Bulk property editor and the CSV importer write straight to the model's property overlay, so neither run reached the undo history: Ctrl+Z did nothing, the model was not flagged as having unsaved changes, and cancelling a Bulk run left the chunks it had already applied in place with no way back. Both now record their run as a single undo step (one Ctrl+Z reverts the run, one Ctrl+Y re-applies it) and mark the model as changed. A cancelled Bulk run says how far it got, and undo reverts what it applied.

Undo and redo of a batch no longer recurse once per change and commit the stacks in one update, so a 10,000-element batch undoes in milliseconds instead of overflowing the call stack.

`ImportStats` (`@ifc-lite/mutations`) gains `mutations`, the list of mutations the import applied, so a host with an undo history can record them.
