/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Model workspace's modeling-command HUD (charter #6232, WP2): the
 * command bar chrome and the units its typed fields show. Each command's own
 * label, field names and hints live beside it in this catalogue too.
 */
export const modelingCommandEn = {
  'modelingCommand.closeAria': 'Leave the command',
  'modelingCommand.unit.m': 'm',
  'modelingCommand.unit.deg': '°',
  'modelingCommand.unit.count': '',
  'modelingCommand.wall.label': 'Wall',
  'modelingCommand.wall.length': 'Length',
  'modelingCommand.wall.angle': 'Angle',
  'modelingCommand.wall.hintStart': 'Click to start the wall · type a length to lock it',
  'modelingCommand.wall.hintNext': 'Click or Enter to place · type a length, Tab for the angle · Backspace drops a point · Esc stops',
  'modelingCommand.wall.noPlane': 'No storey to draw on: pick a storey in the Add Element panel',
  'modelingCommand.wall.tooShort': 'The wall needs a length',
  'modelingCommand.wall.align': 'Which line the drawn line is',
  'modelingCommand.wall.alignLeft': 'Left',
  'modelingCommand.wall.alignCentre': 'Centre',
  'modelingCommand.wall.alignRight': 'Right',
  'modelingCommand.field.width': 'Width',
  'modelingCommand.field.depth': 'Depth',
  'modelingCommand.field.height': 'Height',
  'modelingCommand.field.thickness': 'Thickness',
  'modelingCommand.field.rotation': 'Rotation',
  'modelingCommand.chain.label': 'Chain',
  'modelingCommand.chain.title': 'Keep drawing from the last end',
  'modelingCommand.class.label': 'IFC class',
  'modelingCommand.class.slab': 'Slab',
  'modelingCommand.class.roof': 'Roof',
  'modelingCommand.class.plate': 'Plate',
  'modelingCommand.class.beam': 'Beam',
  'modelingCommand.class.member': 'Member',
  'modelingCommand.slab.label': 'Slab',
  'modelingCommand.slab.mode': 'Outline',
  'modelingCommand.slab.rectangle': 'Rectangle',
  'modelingCommand.slab.polygon': 'Polygon',
  'modelingCommand.slab.hintCorner': 'Click the first corner · type a width to lock it',
  'modelingCommand.slab.hintOpposite': 'Click the opposite corner or press Enter · Shift squares it · Esc starts over',
  'modelingCommand.slab.hintVertex': 'Click to add a corner · Backspace drops one · Esc starts over',
  'modelingCommand.slab.hintClose': 'Click to add a corner · Enter, a double-click or the first corner closes it',
  'modelingCommand.slab.needThree': 'A polygon needs at least three corners',
  'modelingCommand.slab.noArea': 'The rectangle needs a width and a depth',
  'modelingCommand.column.label': 'Column',
  'modelingCommand.column.hint': 'Click to place the column · R turns it 15° · Esc leaves',
  'modelingCommand.beam.label': 'Beam',
  'modelingCommand.beam.bottom': 'Bottom at',
  'modelingCommand.beam.hintStart': 'Click to start the beam · type a length to lock it',
  'modelingCommand.beam.tooShort': 'The beam needs a length',
  'modelingCommand.wallEnd.label': 'Wall end',
  'modelingCommand.wallEnd.hint': 'Release to set the wall end · Esc cancels',
  'modelingCommand.split.noTarget': 'Select the element to split first',
  'modelingCommand.split.noPlane': "This element's storey has no placement that resolves in plan",
  'modelingCommand.split.needLine': 'Click two points to draw the cut line',
  'modelingCommand.split.outOfRange': 'Point at the element, or type a distance along it',
} as const satisfies Record<string, TranslationValue>;
