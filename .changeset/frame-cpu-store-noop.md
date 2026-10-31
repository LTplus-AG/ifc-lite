---
"@ifc-lite/viewer": patch
---

Orbiting no longer re-renders the viewer on every pointer move: a store action that returns the current state stays a no-op through the visibility-ownership middleware (it used to bump `visibilityRevision` and notify every subscriber), and `clearHover` skips the store entirely while hover is already clear.
