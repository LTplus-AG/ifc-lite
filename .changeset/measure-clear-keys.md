---
"@ifc-lite/viewer": patch
---

Measure tool: Ctrl/Cmd+C and Delete/Backspace no longer wipe every measurement (#5598). Ctrl+C is left to mean copy, and Delete with nothing selected does nothing. The Measure panel's "Clear all" button stays the one way to clear, and now asks for confirmation first, since measurements cannot be undone.
