/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Model workspace's Room tool (charter #6232 M4, `room.place`): its rail
 * row, bar, hints and refusals. IFC class names and unit symbols stay
 * untranslated.
 */
export const roomToolEn = {
  'roomTool.label': 'Room',
  'commands.model.room': 'Make rooms from walls or draw them (Model workspace)',
  'roomTool.hint.pick': 'Click inside walls to make a room · Auto makes every room on this storey',
  'roomTool.hint.taken': 'This area already has a room',
  'roomTool.hint.drawCorner': "Click the room's corners",
  'roomTool.hint.drawClose': 'Enter, a double-click or a click on the first corner closes the room',
  'roomTool.mode.label': 'How to make a room',
  'roomTool.mode.pick': 'Pick',
  'roomTool.mode.draw': 'Draw',
  'roomTool.boundary.label': 'Which wall face the room follows',
  'roomTool.boundary.inner': 'Inner',
  'roomTool.boundary.center': 'Axis',
  'roomTool.boundary.outer': 'Outer',
  'roomTool.auto.label': 'Auto · {countDisplay}',
  'roomTool.auto.title': 'Make every area of this storey enclosed by walls that has no room yet a room, in one undo step',
  'roomTool.auto.none': 'Every area of this storey enclosed by walls already has a room',
  'roomTool.update.label': 'Update rooms',
  'roomTool.update.title': "Re-derive the selected rooms' outlines from the walls as they are now",
  'roomTool.update.noSelection': 'Select the rooms to update first',
  'roomTool.update.none': "None of the selected rooms could be updated: each must be a plan extrusion on a storey, inside walls",
  'roomTool.update.skipped': {
    one: '{countDisplay} selected room was left as it was: it is not a plan extrusion on a storey, or no walls enclose it',
    other: '{countDisplay} selected rooms were left as they were: they are not plan extrusions on a storey, or no walls enclose them',
  },
  'roomTool.wasmFailed': "The room engine didn't load, so rooms can't be derived: reload the page and try again",
  'roomTool.palette': 'Make rooms',
  'roomTool.loading': 'Reading the walls… try again in a moment',
  'roomTool.noWalls': 'No walls on this storey enclose a room: draw the walls, or switch to Draw',
  'roomTool.pick.none': 'No walls enclose this point: click inside a room, or switch to Draw',
  'roomTool.pick.taken': 'This area already has a room',
  'roomTool.draw.needThree': 'A room needs at least three corners',
} as const satisfies Record<string, TranslationValue>;
