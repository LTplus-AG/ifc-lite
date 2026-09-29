/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * Stairs and railings (charter #6232, D1): the Stair and Railing tools of the
 * Model workspace and their command bars. IFC class names and unit symbols
 * stay untranslated.
 */
export const stairRailingEn = {
  'stairRailing.tool.stair': 'Stair',
  'stairRailing.tool.railing': 'Railing',
  'stairRailing.stair.label': 'Stair',
  'stairRailing.railing.label': 'Railing',
  'stairRailing.field.riser': 'Riser',
  'stairRailing.field.tread': 'Tread',
  'stairRailing.field.waist': 'Waist',
  'stairRailing.field.postSpacing': 'Posts',
  'stairRailing.stair.hintStart': 'Click the foot of the first riser · type a length to lock the run',
  'stairRailing.stair.hintEnd': 'Click or Enter to place the stair · type a length, Tab for the angle, riser, tread · Backspace starts over · Esc leaves',
  'stairRailing.stair.tooShort': 'The run is too short: treads under 0.1 m are not a stair. Draw it longer, or ask for a taller riser to fit fewer steps',
  'stairRailing.stair.waistTooThick': 'The waist is too thick for a flight of this rise: type a thinner one',
  'stairRailing.stair.risers': {
    one: '{countDisplay} riser · up to {storey}',
    other: '{countDisplay} risers · up to {storey}',
  },
  'stairRailing.stair.risersFree': {
    one: '{countDisplay} riser · no storey above',
    other: '{countDisplay} risers · no storey above',
  },
  'stairRailing.railing.hintStart': 'Click to start the railing · snaps to slab edges and stair sides · type a length to lock it',
  'stairRailing.railing.hintNext': 'Click to add a point · double-click or Enter to finish · Backspace drops a point · Esc starts over',
  'stairRailing.railing.needTwo': 'A railing needs at least two points',
  'stairRailing.railing.summary': {
    one: '{countDisplay} point · {length}',
    other: '{countDisplay} points · {length}',
  },
  'stairRailing.railing.finish': 'Finish',
  'stairRailing.railing.finishTitle': 'Place the railing along the points so far (Enter)',
  'commandPalette.tool.stair.label': 'Draw stairs',
  'commandPalette.tool.railing.label': 'Draw railings',
  'commands.model.stair': 'Draw a stair up to the storey above (Model workspace)',
  'commands.model.railing': 'Draw a railing along a path (Model workspace)',
} as const satisfies Record<string, TranslationValue>;
