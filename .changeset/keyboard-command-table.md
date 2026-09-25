---
"@ifc-lite/viewer": patch
---

Keyboard shortcuts now have one home. The Shortcuts tab is generated from a
keyboard command table, is translated, and lists bindings it used to leave out,
among them Backspace, Ctrl+D, Ctrl+F and `/`, n / Shift+N, Ctrl+Shift+F, Ctrl+L,
and the Schedule and script-editor keys.

Every key hint comes from the same table and follows the platform: `⌘Z` on macOS
and iOS, `Ctrl+Z` on Windows and Linux. Before, the ribbon, classic toolbar and
context menu showed `⌘` everywhere, and the script editor and Schedule tooltips
showed `Ctrl` on a Mac too. This covers the ribbon, classic toolbar, camera
menu, command palette, context menu (including Duplicate), chat panel, search
field, Space sketch, Schedule and script editor, and the "… to undo" toasts.
