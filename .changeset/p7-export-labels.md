---
"@ifc-lite/viewer": patch
---

Export labels now say what the export contains (#5835). "Export JSON (All Data)" is "Export JSON (active model)", since it only ever exported the active model. The toolbar's "Export Changes", which exports whole IFC files with the edits applied, is "Export modified IFC…". The IFC dialog's "Changes Only" toggle is "Changes only (JSON delta)", or "Changes only (IFCX overlay)" for an IFC5 model, so it no longer reads like the toolbar button.
