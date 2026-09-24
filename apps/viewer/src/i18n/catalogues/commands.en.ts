/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Keyboard commands (#5836): what each row of `lib/commands/keyboard-commands.ts`
 * does, as the generated Shortcuts tab says it, plus the category headings and
 * the pointer gestures listed beside the keys. The key glyphs themselves are
 * not strings here: they are formatted from chords per platform.
 */
export const commandsEn = {
  // Categories
  'commands.category.editing': 'Editing',
  'commands.category.tools': 'Tools',
  'commands.category.selection': 'Selection',
  'commands.category.visibility': 'Visibility',
  'commands.category.camera': 'Camera',
  'commands.category.search': 'Search',
  'commands.category.ui': 'UI',
  'commands.category.help': 'Help',

  // Editing
  'commands.edit.undo': 'Undo last model move or active-model authoring change',
  'commands.edit.redo': 'Redo last undone change',
  'commands.edit.toggleEditMode': 'Toggle edit mode (unlocks property + geometry edits)',
  'commands.edit.rotate': 'Rotate selected entity +15° / −15° about Z (requires edit mode)',
  'commands.edit.duplicate': 'Duplicate the selected entity (+X; add Shift for +Z, Alt for +Y)',

  // Tools
  'commands.tool.select': 'Select tool',
  'commands.tool.walk': 'Walk mode',
  'commands.tool.measure': 'Measure tool',
  'commands.tool.annotate': 'Annotate tool — drop a pin with a note',
  'commands.tool.section': 'Section tool',
  'commands.tool.split': 'Split the selected entity (press again to leave Split)',
  'commands.split.exit': 'Leave Split (Split tool)',
  'commands.walk.move': 'Walk forward / left / back / right (Walk mode, Shift = sprint)',
  'commands.walk.moveArrows': 'Walk with the arrow keys (Walk mode)',
  'commands.measure.toggleSnap': 'Toggle snapping (Measure tool)',
  'commands.measure.cancel': 'Cancel the measurement in progress (Measure tool)',
  'commands.measure.finish': 'Finish the polyline as open length, or the radius fit (Measure tool)',
  'commands.addElement.commit': 'Close the slab, roof, plate or space outline (Add element, polygon mode)',
  'commands.addElement.clearPending': 'Clear the points placed so far (Add element)',
  'commands.spaceSketch.undo': 'Undo the last sketch step (Space sketch)',
  'commands.spaceSketch.redo': 'Redo the sketch step (Space sketch)',
  'commands.spaceSketch.commit': 'Close the drawn room (Space sketch)',
  'commands.spaceSketch.cancel': 'Abort the current step; press twice to close (Space sketch)',
  'commands.drawing2d.cancel': 'Cancel the 2D tool and clear its selection (2D drawing)',
  'commands.drawing2d.delete': 'Delete the selected 2D annotation (2D drawing)',
  'commands.drawing2d.orthogonal': 'Hold to keep the 2D measurement horizontal or vertical (2D drawing)',
  'commands.reposition.apply': 'Apply the move (Reposition panel)',
  'commands.reposition.constrain': 'Constrain the move to the X, Y or Z axis (Reposition panel)',
  'commands.reposition.nudge': 'Nudge along the chosen axis (Reposition panel)',
  'commands.schedule.cancelDrag': 'Cancel the bar drag (Schedule)',

  // Selection
  'commands.selection.escape': 'Cancel the current step, leave the tool, then clear the selection (keeps visibility)',

  // Visibility
  'commands.visibility.hideSelection': 'Hide selection',
  'commands.visibility.showAll': 'Show all (clear filters and basket)',
  'commands.basket.isolate': 'Isolate (set basket from current context)',
  'commands.basket.set': 'Set basket from current context',
  'commands.basket.add': 'Add current context to basket',
  'commands.basket.remove': 'Remove current context from basket',
  'commands.basket.toggleDock': 'Toggle basket presentation dock',
  'commands.basket.saveView': 'Save basket as presentation view',

  // Camera
  'commands.camera.home': 'Home (isometric + reset visibility)',
  'commands.camera.fitAll': 'Fit all (zoom extents)',
  'commands.camera.frameSelection': 'Frame selection',
  'commands.camera.viewTop': 'Top view',
  'commands.camera.viewBottom': 'Bottom view',
  'commands.camera.viewFront': 'Front view',
  'commands.camera.viewBack': 'Back view',
  'commands.camera.viewLeft': 'Left view',
  'commands.camera.viewRight': 'Right view',
  'commands.camera.pan': 'Pan the view',
  'commands.flight.move': 'Fly forward / left / back / right (Shift = 3× faster, Alt = 3× slower)',
  'commands.flight.upDown': 'Fly up / down',

  // Search
  'commands.search.focus': 'Focus the search field',
  'commands.search.openAdvanced': 'Open advanced search',
  'commands.search.nextMatch': 'Next match (while stepping through matches)',
  'commands.search.previousMatch': 'Previous match (while stepping through matches)',
  'commands.search.exitCycle': 'Stop stepping through matches',

  // UI
  'commands.ui.commandPalette': 'Command palette',
  'commands.ui.openPanel': 'Open a panel from the rail ({sidePanels}; {bottomPanels} open at the bottom)',
  'commands.ui.toggleSidebar': 'Toggle sidebar (expand ⇄ collapse to icons)',
  'commands.ui.closeAllPanels': 'Close all panels (keeps visibility)',
  'commands.ui.closeOverlay': 'Close the open menu or dialog',
  'commands.ui.toggleTheme': 'Toggle theme',
  'commands.chat.focusInput': 'Focus the chat input (AI chat)',

  // Help
  'commands.help.shortcuts': 'Show keyboard shortcuts',

  // Pointer gestures
  'commands.gesture.flightLook.keys': 'Right mouse (hold)',
  'commands.gesture.flightLook': 'Fly: move the mouse to look around; add W/A/S/D and E/Q to move',
  'commands.gesture.flightSpeed.keys': 'Right mouse + wheel',
  'commands.gesture.flightSpeed': 'Change fly speed',
  'commands.gesture.panDrag.keys': 'Middle mouse drag',
  'commands.gesture.panDrag': 'Pan',
  'commands.gesture.fineZoom.keys': '{mod} + wheel',
  'commands.gesture.fineZoom': 'Zoom in finer steps',
} as const satisfies Record<string, TranslationValue>;
