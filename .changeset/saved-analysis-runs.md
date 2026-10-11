---
"@ifc-lite/viewer": minor
---

Compare can now save a captured clash or validation run for reconciliation and reopen it after a reload. A saved run stores the native result with each model identified by its file name, source identity and, for clash runs, its placement, never by viewer model ids. Reopening refuses, naming each reason, when a model (for a clash run, any model open when it ran) is not open, is another version of the file, is ambiguous, has no recorded source, has moved or has unsaved edits. Runs saved out of date or of unknown freshness stay that way. Saved runs are immutable and travel with library backup, import and recovery.
