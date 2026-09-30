/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Room tool's layout editing and Space Sketch parity (charter #6232 M4,
 * lane A4b): Edit mode, Footprint, Auto on every storey, the corner weld and
 * leak diagnostics. IFC class names and unit symbols stay untranslated.
 */
export const roomLayoutEn = {
  'roomLayout.mode.edit': 'Edit',
  'roomLayout.tool.label': 'What a click on the layout does',
  'roomLayout.tool.shape': 'Move · Cut',
  'roomLayout.tool.remove': 'Merge · Remove',
  'roomLayout.tool.shapeTitle': 'Drag a corner to move it; click two points on a room outline to cut the room between them',
  'roomLayout.tool.removeTitle': 'Click the wall between two rooms to merge them; click a corner to remove it',
  'roomLayout.cleanup.label': 'Clean up',
  'roomLayout.cleanup.title': 'Remove dangling walls, loose nodes and extra corners from the layout, in one undo step',
  'roomLayout.hint.shape': 'Drag a corner to move it · click a room outline to start a cut',
  'roomLayout.hint.remove': 'Click the wall between two rooms to merge them, or a corner to remove it',
  'roomLayout.hint.drop': 'Release, or click, to drop the corner · Esc cancels',
  'roomLayout.hint.cutEnd': 'Click another point on the same room outline to cut it · Esc cancels',
  'roomLayout.hint.open': 'No walls close this area: the open wall ends are marked',
  'roomLayout.edit.none': 'Point at a corner or a room outline first',
  'roomLayout.edit.refused': "The layout can't take this edit: {reason}",
  'roomLayout.prune.none': 'Nothing to clean up: the layout has no loose walls or nodes',
  'roomLayout.refused.shape': "A room here isn't an outline extruded straight up, so its shape can't be edited: use Update rooms or redraw it",
  'roomLayout.refused.storey': "A room here isn't on a storey, so its shape can't be edited",
  'roomLayout.refused.merge': "One of the merged rooms couldn't be removed",
  'roomLayout.more.label': 'More',
  'roomLayout.more.title': 'Footprint, Auto on every storey, corner weld and leak diagnostics',
  'roomLayout.footprint.label': 'Footprint',
  'roomLayout.footprint.title': "One room over this storey's whole outline, in one undo step",
  'roomLayout.footprint.taken': 'This storey already has rooms: Footprint makes one room over the whole storey, so it would overlap them',
  'roomLayout.autoAll.label': 'Auto on every storey',
  'roomLayout.autoAll.title': 'Make every area enclosed by walls that has no room yet a room, on every storey, in one undo step',
  'roomLayout.autoAll.none': 'Every area enclosed by walls on every storey already has a room',
  'roomLayout.weld.label': 'Corner weld',
  'roomLayout.weld.title': 'How close two wall corners must be to count as one: raise it when walls that meet leave a room open',
  'roomLayout.weld.aria': 'Corner weld (metres)',
  'roomLayout.weld.auto': 'Default (5 cm)',
  'roomLayout.weld.reset': 'Reset to the 5 cm default',
  'roomLayout.weld.rooms': {
    one: '{countDisplay} room',
    other: '{countDisplay} rooms',
  },
  'roomLayout.leaks.label': 'Show leaks',
  'roomLayout.leaks.title': "Mark the walls that enclose no room and the wall ends that touch nothing: why an area isn't closed",
} as const satisfies Record<string, TranslationValue>;
