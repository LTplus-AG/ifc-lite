---
"@ifc-lite/viewer": patch
---

Keyboard shortcuts no longer fire outside their context (#5596). Ctrl/Cmd/Alt chords such as Ctrl+Z (undo), Ctrl+F (search) and Alt+1 (open panel) no longer also move the camera; while the Walk tool is active, W/A/S/D and the arrow keys only move you, so A no longer shows all hidden elements and D no longer toggles the presentation dock; and typing in a dropdown, combobox, list, slider or menu no longer triggers single-key shortcuts.
