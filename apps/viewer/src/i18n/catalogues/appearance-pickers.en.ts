/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Dynamic source and viewport-pick labels shared by appearance workflows. */
export const appearancePickersEn = {
  'appearance.scan.surfaceSource': '{model} · Surface {number}',
  'appearance.scan.pointCloudSource': '{model} · Point cloud ({retained} of {seen} points retained)',
  'appearance.facePicker.error.miss': 'No visible surface under the pointer.',
  'appearance.facePicker.error.differentSurface': 'Pick a face on the object open in the face editor.',
  'appearance.facePicker.error.ambiguous': 'This rendered face has no exact source identity. Reload the model and try again.',
  'appearance.facePicker.error.busy': 'Wait for the current appearance preview to finish.',
} as const satisfies Record<string, TranslationValue>;
