/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shortcut list shown in the keyboard-shortcuts dialog.
 *
 * Display data, kept beside the hook that implements the key handling but not
 * inside it: the list also documents gestures no `keydown` handler owns (the
 * mouse ones), and it grows with every feature while the hook does not.
 */

// Export shortcut definitions for UI display
export const KEYBOARD_SHORTCUTS = [
  { key: 'Ctrl+Z / Cmd+Z', description: 'Undo last model move or active-model authoring change', category: 'Editing' },
  { key: 'Ctrl+Shift+Z / Cmd+Shift+Z', description: 'Redo last undone change', category: 'Editing' },
  { key: 'V', description: 'Select tool', category: 'Tools' },
  { key: 'C', description: 'Walk mode', category: 'Tools' },
  { key: 'M', description: 'Measure tool', category: 'Tools' },
  { key: 'P', description: 'Annotate tool — drop a pin with a note', category: 'Tools' },
  { key: 'X', description: 'Section tool', category: 'Tools' },
  { key: 'E', description: 'Toggle edit mode (unlocks property + geometry edits)', category: 'Tools' },
  { key: 'K', description: 'Split the selected entity (requires a selection)', category: 'Tools' },
  { key: 'R / Shift+R', description: 'Rotate selected entity ±15° about Z (requires edit mode)', category: 'Tools' },
  { key: 'S', description: 'Toggle snapping (Measure tool)', category: 'Tools' },
  { key: 'Esc', description: 'Cancel measurement (Measure tool)', category: 'Tools' },
  { key: 'Enter', description: 'Finish polyline as open length (Measure tool, polyline mode)', category: 'Tools' },
  { key: 'Enter', description: 'Finish radius/diameter fit (Measure tool, radius mode)', category: 'Tools' },
  { key: 'Ctrl+C', description: 'Clear measurements (Measure tool)', category: 'Tools' },
  { key: 'I', description: 'Isolate (set basket from current context)', category: 'Visibility' },
  { key: '=', description: 'Set basket from current context', category: 'Visibility' },
  { key: '+', description: 'Add current context to basket', category: 'Visibility' },
  { key: '−', description: 'Remove current context from basket', category: 'Visibility' },
  { key: 'D', description: 'Toggle basket presentation dock', category: 'Visibility' },
  { key: 'B', description: 'Save basket as presentation view', category: 'Visibility' },
  { key: 'Del / Space', description: 'Hide selection', category: 'Visibility' },
  { key: 'A', description: 'Show all (clear filters and basket)', category: 'Visibility' },
  { key: 'H', description: 'Home (isometric + reset visibility)', category: 'Camera' },
  { key: 'Z', description: 'Fit all (zoom extents)', category: 'Camera' },
  { key: 'F', description: 'Frame selection', category: 'Camera' },
  { key: '1-6', description: 'Preset views', category: 'Camera' },
  { key: 'Right mouse (hold)', description: 'Fly: move the mouse to look around', category: 'Camera' },
  { key: 'RMB + W/A/S/D', description: 'Fly forward / left / back / right (Shift = 3× faster, Alt = 3× slower)', category: 'Camera' },
  { key: 'RMB + E / Q', description: 'Fly up / down', category: 'Camera' },
  { key: 'RMB + Wheel', description: 'Change fly speed', category: 'Camera' },
  { key: 'Middle mouse drag', description: 'Pan', category: 'Camera' },
  { key: 'T', description: 'Toggle theme', category: 'UI' },
  { key: 'Alt+1…0', description: 'Open a panel from the rail (Info, Compare, BCF, IDS, Lens, Clash, Extensions; Script, Schedule, Lists open at the bottom)', category: 'UI' },
  { key: 'Alt+\\', description: 'Toggle sidebar (expand ⇄ collapse to icons)', category: 'UI' },
  { key: 'Esc', description: 'Reset all (clear selection, basket, isolation)', category: 'Selection' },
  { key: 'Esc Esc', description: 'Close all panels (return to starting view)', category: 'UI' },
  { key: 'Ctrl+K', description: 'Command palette', category: 'UI' },
  { key: '?', description: 'Show info panel', category: 'Help' },
] as const;
