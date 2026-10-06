/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EvidenceAdapter } from './types';
import { changesAdapter } from './changes';
import { changeSetsAdapter } from './change-sets';
import { scheduleAdapter } from './schedule';
import { semanticAdapter } from './semantic';

export const PACK: readonly EvidenceAdapter[] = [changesAdapter, changeSetsAdapter, scheduleAdapter, semanticAdapter];
