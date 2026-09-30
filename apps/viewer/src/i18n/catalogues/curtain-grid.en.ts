/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Model workspace's Curtain Wall and Grid tools (charter #6232, D3:
 * `curtainwall.place`, `grid.place`): rail rows, command bars, hints and
 * refusals. IFC class names and unit symbols stay untranslated.
 */
export const curtainGridEn = {
  'curtainWall.label': 'Curtain wall',
  'curtainWall.palette': 'Place curtain walls',
  'commands.model.curtainWall': 'Place curtain walls: mullions, transoms and panels (Model workspace)',
  'curtainWall.hint.start': 'Click to start the curtain wall · type a length to lock it',
  'curtainWall.hint.end': 'Click or press Enter to place it · the grid shows its panels · Esc starts over',
  'curtainWall.field.baseOffset': 'Base',
  'curtainWall.field.panelWidth': 'Panel W',
  'curtainWall.field.panelHeight': 'Panel H',
  'curtainWall.field.mullionWidth': 'Mullion W',
  'curtainWall.field.mullionDepth': 'Mullion D',
  'curtainWall.tooShort': 'The curtain wall is too short: click further from the start',
  'curtainWall.noOpening': 'The mullions and transoms leave no clear opening: widen the panels or slim the mullion',
  'curtainWall.tooManyPanels': 'That panel size makes too many panels: make them larger',
  'curtainWall.summary': '{bays} × {rows} panels',
  'grid.label': 'Grid',
  'grid.palette': 'Place grids',
  'commands.model.grid': 'Place a design grid with tagged axes (Model workspace)',
  'grid.hint.corner': 'Click the first corner of the grid · type a width to lock it',
  'grid.hint.opposite': 'Click the opposite corner or press Enter · Shift squares it · Esc starts over',
  'grid.field.spacingU': 'U spacing',
  'grid.field.spacingV': 'V spacing',
  'grid.tags.label': 'How the axes are tagged',
  'grid.tags.numbers': '1, 2, 3',
  'grid.tags.letters': 'A, B, C',
  'grid.noArea': 'The grid has no area: click a corner away from the first one',
  'grid.tooManyAxes': 'That spacing makes too many axes: widen it',
  'grid.summary': '{uAxes} × {vAxes} axes',
} as const satisfies Record<string, TranslationValue>;
