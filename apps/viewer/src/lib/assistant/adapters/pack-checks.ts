/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EvidenceAdapter } from './types';
import { duplicatesAdapter } from './duplicates';
import { manualChecklistAdapter } from './manual-checklist';
import { lensAdapter } from './lens';
import { bcfAdapter } from './bcf';

export const PACK: readonly EvidenceAdapter[] = [duplicatesAdapter, manualChecklistAdapter, lensAdapter, bcfAdapter];
