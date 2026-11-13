---
"@ifc-lite/viewer": patch
---

Overlapping model loads no longer end each other's loading UI: the load that finishes first leaves the spinner, progress and Cancel to the loads still running, and only the last one to end clears them. Cancelling a primary load from the activity tray now also stops the federated additions joining its scene and returns to an empty, idle viewer instead of leaving a stuck spinner and a half-loaded model.
