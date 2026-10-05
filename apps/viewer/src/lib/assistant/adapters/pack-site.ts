/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EvidenceAdapter } from './types';
import { zonesAdapter } from './zones';
import { placementAdapter } from './placement';
import { layerDiffAdapter } from './layer-diff';
import { selectionAdapter } from './selection';

export const PACK: readonly EvidenceAdapter[] = [zonesAdapter, placementAdapter, layerDiffAdapter, selectionAdapter];
