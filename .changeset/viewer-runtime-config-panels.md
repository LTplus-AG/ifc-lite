---
"@ifc-lite/viewer": minor
---

A deploying host can switch off the viewport tools (measure, section, walk, annotate) and the display, checking, data and automation panels through the viewer configuration. A panel that is off is not offered, cannot be opened by any path and is never rendered, so its lazy chunk is not requested; its commands leave the command palette, ribbon, context menu and phone toolbar, and its shortcuts are not registered.
