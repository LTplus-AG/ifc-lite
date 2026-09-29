/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Hosted placement (charter #6232, A1): the Opening, Door and Window tools of
 * the Model workspace, their command bar, and the inspector's Hosting
 * section. IFC class names and unit symbols stay untranslated.
 */
export const hostedPlaceEn = {
  'hostedPlace.tool.opening': 'Opening',
  'hostedPlace.tool.door': 'Door',
  'hostedPlace.tool.window': 'Window',
  'hostedPlace.hint.opening': 'Point at a wall and click to cut an opening · Esc leaves',
  'hostedPlace.hint.door': 'Point at a wall and click to place the door · Esc leaves',
  'hostedPlace.hint.window': 'Point at a wall and click to place the window · Esc leaves',
  'hostedPlace.field.offset': 'Offset',
  'hostedPlace.field.sill': 'Sill',
  'hostedPlace.noHost': 'Doors, windows and openings go in a wall: point at one on this storey',
  'hostedPlace.outsideHost': "It doesn't fit in this wall: change its offset, sill or size",
  'commandPalette.tool.opening.label': 'Cut openings',
  'commandPalette.tool.door.label': 'Place doors',
  'commandPalette.tool.window.label': 'Place windows',
  'commands.model.opening': 'Cut openings into walls (Model workspace)',
  'commands.model.door': 'Place doors in walls (Model workspace)',
  'commands.model.window': 'Place windows in walls (Model workspace)',
  'modelInspector.hosting.host': 'Host',
  'modelInspector.hosting.selectHost': 'Select host',
  'modelInspector.hosting.offset': 'Offset',
  'modelInspector.hosting.sill': 'Sill',
  'modelInspector.hosting.none': 'Not hosted: this element fills no opening in a wall.',
  'modelInspector.hosting.invalid': 'Type a length in metres',
  'modelInspector.type.noClass': '{schema} has no {typeClass}, so this element keeps no type.',
} as const satisfies Record<string, TranslationValue>;
