/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Space Sketch (DCEL) tool (#4918 slice; on the HUD since #5503): its
 * bar, plan card, hint and parked chip (`space-sketch/SpaceSketchHud`),
 * its two disclosure popovers (`space-sketch/SpaceSketchPopovers` —
 * Options and the gesture Help legend), and the canvas's one tooltip
 * (`space-sketch/SpaceSketchCanvas`'s "unbounded boundary" `<title>`).
 * The tool's live `setStatus(...)` narration strings (drag/undo/derive
 * progress messages) are plain function-call arguments, not JSX, and are
 * out of this slice's gate-driven scope.
 */
export const spaceSketchEn = {
  // Parked chip (minimized tool)
  'spaceSketch.parkedChip.resumeTitle': 'Reopen the Space Sketch tool',
  'spaceSketch.parkedChip.label': 'Space Sketch',
  'spaceSketch.parkedChip.toConfirm': '{count} to confirm',

  // Bar
  'spaceSketch.panel.heading': 'Space Sketch',
  'spaceSketch.bar.storeyAria': 'Storey to sketch on',
  'spaceSketch.bar.drawModeAria': 'Draw mode',
  // Compact-mode overflow trigger (#5975): shown once the bar no longer
  // fits the top-center lane at both side panels open, in place of the
  // inline history/snap/Help controls it replaces.
  'spaceSketch.bar.moreTitle': 'More: history, snap, help',
  'spaceSketch.panel.helpTitle': 'How it works',
  'spaceSketch.panel.minimizeTitle': 'Minimize (drafts and 3D preview stay live)',
  'spaceSketch.panel.closeTitle': 'Close without creating (Esc)',
  'spaceSketch.panel.noModelOption': 'no model',
  'spaceSketch.panel.deriveAllTitle': 'Derive rooms on every storey. Drafts only until you confirm; storeys you already edited are kept.',
  'spaceSketch.panel.roomCount': { other: '{count} rooms', one: '{count} room' },
  'spaceSketch.panel.resizeTitle': 'Drag to resize the plan',

  // Tool row
  'spaceSketch.tools.editTitle': 'Edit / freeform: drag corners, split, merge, draw a polygon room',
  'spaceSketch.tools.rectTitle': 'Rectangle room: click two opposite corners (Shift = square)',
  'spaceSketch.tools.footprintArmedTitle': "Click again to replace this storey's {count} drafted room(s) with one footprint room",
  'spaceSketch.tools.footprintTitle': 'Footprint: one room over the whole storey outline (convex outline of its walls)',
  'spaceSketch.tools.undoTitle': 'Undo (Ctrl+Z)',
  'spaceSketch.tools.redoTitle': 'Redo (Ctrl+Shift+Z)',
  'spaceSketch.tools.snapOnTitle': 'Snap to walls + corners: on',
  'spaceSketch.tools.snapOffTitle': 'Snap to walls + corners: off',
  // The More popover's checkbox row (#5975) needs a state-agnostic label,
  // unlike the icon button's on/off tooltip pair above.
  'spaceSketch.tools.snapLabel': 'Snap to walls + corners',
  'spaceSketch.tools.optionsTitle': 'Options: boundary, corner tolerance, underlay, generate all storeys',
  'spaceSketch.tools.cleanupTitle': 'Clean up: remove orphaned inner walls and redundant nodes (room shapes unchanged)',
  'spaceSketch.tools.fitTitle': 'Fit plan to canvas (reset zoom & pan)',

  // Footer: in-progress hints, unbounded-boundary notice, leak diagnostics, confirm/close
  'spaceSketch.footer.rectHint': 'Click the opposite corner · Shift = square · Esc cancels.',
  'spaceSketch.footer.drawHint': 'Click corners · Enter / double-click / first dot to close · Shift = straight · Esc cancels.',
  'spaceSketch.footer.cutHint': 'Click another wall or corner to finish the cut · Esc cancels.',
  'spaceSketch.footer.unboundedNotice': '{count} room(s) unchanged by "{boundaryMode}" (dashed) — no wall offset.',
  'spaceSketch.footer.diag.bounds': '▬ bounds a room',
  'spaceSketch.footer.diag.leak': '╌ bounds nothing ({count})',
  'spaceSketch.footer.diag.failed': '▦ failed to close ({count})',
  'spaceSketch.footer.confirmTitle': 'Create the drafted spaces on every storey and close',
  'spaceSketch.footer.closeToolTitle': 'Close the Space Sketch tool',
  'spaceSketch.footer.confirmButton': { other: 'Confirm {count} spaces', one: 'Confirm {count} space' },
  // Only rendered when pendingStoreys > 1, so "floors" is always plural in
  // English — one complete plural message with both {count} and {floors}
  // (#4918 review, PR #5001) rather than appending a separately-translated
  // suffix, so a locale can reorder/re-punctuate/re-agree the whole phrase.
  'spaceSketch.footer.confirmButtonMultiStorey': {
    other: 'Confirm {count} spaces across {floors} floors',
    one: 'Confirm {count} space across {floors} floors',
  },
  'spaceSketch.footer.doneButton': 'Done',

  // Canvas tooltip
  'spaceSketch.canvas.unboundedBoundaryTitle':
    'Boundary "{boundaryMode}" made no change to this room — no wall offset applies (no wall runs along its edges, or it\'s fully internal in Outer mode).',

  // Options popover
  'spaceSketch.options.boundaryHeading': 'Boundary',
  'spaceSketch.options.boundary.noWallData': 'No wall data on this derive — only the centreline is available',
  'spaceSketch.options.boundary.centerTitle': 'Wall centreline',
  'spaceSketch.options.boundary.innerTitle': 'Inner (net) face',
  'spaceSketch.options.boundary.outerTitle': 'Outer (gross) face',
  'spaceSketch.options.boundary.centerLabel': 'Center',
  'spaceSketch.options.boundary.innerLabel': 'Inner',
  'spaceSketch.options.boundary.outerLabel': 'Outer',
  'spaceSketch.options.weldToleranceTitle': 'How close two wall-rectangle corners must be to be welded into one when deriving rooms',
  'spaceSketch.options.weldToleranceLabel': 'Weld tolerance',
  'spaceSketch.options.roomsBeforeAfterTitle': 'Rooms before → after',
  'spaceSketch.options.weldToleranceAriaLabel': 'Weld tolerance (metres)',
  'spaceSketch.options.snapDefaultTitle': 'Default (5 cm)',
  'spaceSketch.options.snapResetTitle': 'Reset to the 5 cm default',
  'spaceSketch.options.snapAuto': 'auto',
  'spaceSketch.options.snapReset': 'reset',
  'spaceSketch.options.showBuilding': 'Show building underlay',
  'spaceSketch.options.leakDiagnostics': 'Leak diagnostics',

  // Help popover (gesture legend)
  'spaceSketch.help.heading': 'One tool — actions follow the cursor:',
  'spaceSketch.help.rectangleTool.label': 'Rectangle tool',
  'spaceSketch.help.rectangleTool.desc': 'click two opposite corners (Shift = square)',
  'spaceSketch.help.footprint.label': 'Footprint',
  'spaceSketch.help.footprint.desc': 'one room over the whole storey outline',
  'spaceSketch.help.dragNode.label': 'Drag a node',
  'spaceSketch.help.dragNode.desc': 'move it (snaps; Shift = straight)',
  'spaceSketch.help.clickWallThenAnother.label': 'Click a wall, then another',
  'spaceSketch.help.clickWallThenAnother.desc': 'split the room between them',
  'spaceSketch.help.clickEmptySpace.label': 'Click empty space',
  'spaceSketch.help.clickEmptySpace.desc': 'draw a room (Enter / dbl-click closes)',
  'spaceSketch.help.removeNode.label': '⌥/Ctrl/right-click a node',
  'spaceSketch.help.removeNode.desc': 'remove it (cleans up orphans)',
  'spaceSketch.help.mergeWall.label': '⌥/Ctrl/right-click a wall',
  'spaceSketch.help.mergeWall.desc': 'merge rooms / remove & clean up',
  'spaceSketch.help.panZoom.label': 'Shift-drag / middle-drag',
  'spaceSketch.help.panZoom.desc': 'pan · scroll = zoom',
} as const satisfies Record<string, TranslationValue>;
