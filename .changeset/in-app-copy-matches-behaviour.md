---
"@ifc-lite/viewer": patch
---

In-app text no longer contradicts what the viewer does (#5606). Compare no longer warns that it reads the file as loaded when A or B has unsaved edits: it compares the models as edited, so the notice was wrong and is gone. Pressing `?` now opens the Info dialog on the Shortcuts tab instead of About, and the Alt+1…0 row in the shortcut list names the panels by their current titles, taken from the panel registry (so it says "Data validation", not "IDS").
