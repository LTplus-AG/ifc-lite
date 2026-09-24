---
"@ifc-lite/viewer": patch
---

Keyboard shortcuts now have one home. The Shortcuts tab is generated from a
keyboard command table, is translated, and lists bindings it used to leave out,
among them Backspace, Ctrl+D, Ctrl+F and `/`, n / Shift+N, Ctrl+Shift+F and
Ctrl+L. Key hints in the ribbon, classic toolbar, camera menu, command palette
and context menu come from the same table. They follow the platform: `⌘Z` on
macOS and iOS, `Ctrl+Z` on Windows and Linux, which used to be shown `⌘Z` too.
