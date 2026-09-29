/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Model workspace's storey context control on the storey chip (#6232 D9,
 * `components/viewer/model/StoreyContextControl.tsx`): what 3D does with the
 * storeys above the one being drawn on.
 */
export const storeyContextEn = {
  'storeyContext.button': 'Storeys above: {mode}',
  'storeyContext.group': 'Storeys above this one',
  'storeyContext.mode.hide': 'Hide above',
  'storeyContext.mode.ghost': 'Ghost above',
  'storeyContext.mode.all': 'Show all',
  'storeyContext.state.hide': 'hidden',
  'storeyContext.state.ghost': 'ghosted',
  'storeyContext.state.all': 'shown',
  'storeyContext.soloActive': 'Only this storey is shown',
} as const satisfies Record<string, TranslationValue>;
