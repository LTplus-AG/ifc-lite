---
"@ifc-lite/mutations": minor
"@ifc-lite/viewer": patch
---

Ctrl+Z reaches Bulk edits and CSV imports on any loaded model (#5958).

- The Bulk editor and the CSV importer default to the active model, and a run on another loaded model makes that model active. Undo replays the active model's history, so a run recorded on a different model used to be unreachable from Ctrl+Z and the ribbon Undo (it is reachable again whenever its model is active).
- A run is recorded chunk by chunk under one batch id, so it is one undo step unless another edit lands while it yields; that edit then keeps its place in history between the run's parts (one Ctrl+Z each). Previously the run was recorded only at the end, on top of that edit, and undoing the run overwrote it.
- A Bulk run cancelled during its last yield no longer reports "Cancelled after N of N".

`CsvConnector` (`@ifc-lite/mutations`) no longer loses track of writes when an import throws partway. `import()` and `importAsync()` report every mutation that reached the view in `stats.mutations` and `mutationsCreated`, including the ones applied before a transform or `setProperty` threw, so a host can still undo them. `importAsync()` takes a new `onApplied` option, called after each apply batch with the mutations it wrote (the failing batch's applied part included), so a host can record undo history as the import goes.
