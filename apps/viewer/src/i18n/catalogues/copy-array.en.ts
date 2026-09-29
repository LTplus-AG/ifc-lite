/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Model workspace's copy, paste and array (#6232 C3): the rail row, the
 * keys' descriptions, the Array bar and the hints and refusals of both
 * commands.
 */
export const copyArrayEn = {
  'commands.model.copy': 'Copy the selected elements (Model workspace)',
  'commands.model.paste': 'Paste the copied elements at the cursor (Model workspace)',
  'commands.model.pasteInPlace': 'Paste the copied elements in place, on the current storey (Model workspace)',
  'commands.model.array': 'Repeat the selected elements in a row or around a centre (Model workspace)',
  'copyArray.copied': {
    one: 'Copied {countDisplay} element',
    other: 'Copied {countDisplay} elements',
  },
  'copyArray.paste.label': 'Paste',
  'copyArray.paste.hint': 'Click where the copy goes. To paste on another storey, switch storey first',
  'copyArray.paste.empty': 'Nothing is copied yet: select elements and copy them first',
  'copyArray.paste.otherModel': 'The copied elements are in another model: paste them there',
  'copyArray.tool.array': 'Array',
  'copyArray.blocked.array': 'Select the elements to repeat first',
  'copyArray.array.label': 'Array',
  'copyArray.array.noSelection': 'Select the elements to repeat first',
  'copyArray.array.refused': "These elements can't be repeated: click to see why",
  'copyArray.array.linearStart': 'Click where the direction starts',
  'copyArray.array.linearEnd': 'Click where it ends: that distance is one step (Spacing) or the whole array (Fit)',
  'copyArray.array.polarCentre': 'Click the centre to turn the copies about',
  'copyArray.array.polarCommit': 'Click, or press Enter, to place the copies',
  'copyArray.field.count': 'Count',
  'copyArray.field.spacing': 'Spacing',
  'copyArray.field.total': 'Total',
  'copyArray.field.angle': 'Angle',
  'copyArray.mode.label': 'Kind of array',
  'copyArray.mode.linear': 'Linear',
  'copyArray.mode.polar': 'Polar',
  'copyArray.fit.label': 'What the distance measures',
  'copyArray.fit.spacing': 'Spacing',
  'copyArray.fit.fit': 'Fit',
  'copyArray.fit.spacingTitle': 'The distance is the step from one copy to the next',
  'copyArray.fit.fitTitle': 'The distance spans the whole array',
} as const satisfies Record<string, TranslationValue>;
