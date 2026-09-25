---
"@ifc-lite/viewer": patch
---

Export dialogs can no longer be closed while an export is running (#5605). Escape, a click outside the dialog and the Cancel button used to close the IFC, GLB, USD, KMZ, PDF view and chart report dialogs mid-export, taking the progress indicator and the success or error message with them, so a failed export looked like one that never ran. Cancel is now disabled while exporting, and reopening a dialog no longer shows the previous run's result.
