/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

export const mergeLayersBannerEn = {
  'mergeLayersBanner.titleEnabled': 'Merge Multilayer Walls enabled',
  'mergeLayersBanner.titleDisabled': 'Merge Multilayer Walls disabled',
  'mergeLayersBanner.subtitle': 'Reload model to apply the new setting.',
  'mergeLayersBanner.reloadButton': 'Reload',
  'mergeLayersBanner.dismissAriaLabel': 'Dismiss reload reminder',
  'mergeLayersBanner.serverProcessed': 'This model was processed on the server, so load-time geometry settings do not change it.',
} as const satisfies Record<string, TranslationValue>;
