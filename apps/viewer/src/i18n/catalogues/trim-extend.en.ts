/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * `element.trimExtend` (charter #6232, C1): pick a boundary, then trim walls
 * and beams back to it or extend them out to it. Why a wall cannot be taken at
 * all is the Split button's own catalogue (`splitTool.unavailable.*`).
 */
export const trimExtendEn = {
  'trimExtend.label': 'Trim/Extend',
  'trimExtend.tool': 'Trim / Extend',
  'commands.model.trimExtend': 'Trim or extend to a boundary (Model workspace)',
  'commandPalette.tool.trimExtend.label': 'Trim / Extend',
  'trimExtend.hint.boundary': 'Click the boundary: a wall, a beam, a slab edge or a grid line · Esc leaves',
  'trimExtend.hint.trim': 'Click the part of a wall or beam to cut back to the boundary · hold Shift to extend · Backspace picks another boundary · Esc starts over',
  'trimExtend.hint.extend': 'Click the end of a wall or beam to lengthen to the boundary · hold Shift to trim · Backspace picks another boundary · Esc starts over',
  'trimExtend.noTargets': 'Nothing to trim or extend here: pick a storey with walls or beams',
  'trimExtend.needBoundary': 'Pick a boundary first',
  'trimExtend.needTarget': 'Click a wall or beam to trim or extend',
  'trimExtend.refusedHere': 'This element cannot be trimmed or extended here: the reason is beside it',
  'trimExtend.mode.label': 'Trim or extend',
  'trimExtend.mode.trim': 'Trim',
  'trimExtend.mode.extend': 'Extend',
  'trimExtend.mode.trimTitle': 'Cut the element back to the boundary, removing the side you click (hold Shift to extend)',
  'trimExtend.mode.extendTitle': 'Lengthen the end nearest your click to the boundary (hold Shift to trim)',
  'trimExtend.bar.boundary': 'Boundary: {name}',
  'trimExtend.bar.pickBoundary': 'Pick a boundary',
  'trimExtend.bar.trim': 'Trim {distance} m',
  'trimExtend.bar.extend': 'Extend {distance} m',
  'trimExtend.bar.join': '{kind} join',
  'trimExtend.boundary.wall': 'Wall {name}',
  'trimExtend.boundary.beam': 'Beam {name}',
  'trimExtend.boundary.slab': 'Slab edge of {name}',
  'trimExtend.boundary.grid': 'Grid line',
  'trimExtend.boundary.edge': 'Edge',
  'trimExtend.refused.wallBody': "Can't trim or extend: the join core cannot read this wall's body",
  'trimExtend.refused.vertical': "Can't trim or extend: a vertical member has no plan axis to reach a boundary",
  'trimExtend.refused.parallel': "Can't reach the boundary: the element runs along it",
  'trimExtend.refused.boundaryShort': "Can't reach the boundary: it stops before the element's line meets it",
  'trimExtend.refused.crossesInside': 'Already crosses the boundary: switch to Trim (or hold Shift) to cut it back',
  'trimExtend.refused.notReached': 'Stops short of the boundary: switch to Extend (or hold Shift) to lengthen it',
  'trimExtend.refused.otherEnd': 'The boundary lies past the other end: click nearer that end to extend it',
  'trimExtend.refused.tooShort': 'Trimming here would leave less than the minimum length',
  'trimExtend.refused.alreadyThere': 'Already ends on the boundary',
  'trimExtend.refused.hosted': {
    one: 'Trimming here would cut off {countDisplay} opening, door or window hosted in this wall',
    other: 'Trimming here would cut off {countDisplay} openings, doors or windows hosted in this wall',
  },
  'trimExtend.refused.hostedUnreadable': {
    one: "Can't tell where {countDisplay} opening hosted in this wall sits, so it is not trimmed",
    other: "Can't tell where {countDisplay} openings hosted in this wall sit, so it is not trimmed",
  },
  'trimExtend.refused.join': "Can't join the wall to the boundary: {reason}",
  'trimExtend.failed': "Couldn't resize the wall: {reason}",
  'trimExtend.done.trim': 'Trimmed {name}',
  'trimExtend.done.extend': 'Extended {name}',
  'trimExtend.done.joined': 'joined to the boundary wall',
} as const satisfies Record<string, TranslationValue>;
