---
"@ifc-lite/viewer": patch
---

Replace every native `alert`/`confirm`/`prompt` in the viewer with in-app dialogs (#5813). Confirmations (clear measurements, delete a flow, uninstall an extension, delete or reset a flavor, clear the audit or action log) now open a themed, focus-trapped `alertdialog` whose buttons follow the active locale; name prompts (new flow, rename document or dashboard, save or rename a section cut, save a filter, view transition time) open a labelled text field pre-filled with the current value; export and IFCX-overlay failures show as translated error toasts. None of them freeze the 3D view any more. A new `check-native-dialogs` lint keeps the browser dialogs from coming back.
