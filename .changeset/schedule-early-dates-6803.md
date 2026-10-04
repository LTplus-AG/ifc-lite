---
"@ifc-lite/viewer": patch
---

Fall back to `EarlyStart`/`EarlyFinish` for a task's window when its IfcTaskTime has no planned or actual date (#6803). buildingSMART's construction-scheduling sample writes leaf tasks this way, and those tasks used to get no Gantt bar or 4D window. The Gantt, schedule range, 4D animator, charts, Properties schedule card, bar drag and add-task anchoring now all resolve the window through one resolver. This removes the old copies that had diverged: the animator ignored start + duration, and the charts parsed TZ-less dates as local time. Files that carry planned or actual dates resolve exactly as before.
