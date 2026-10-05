/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EvidenceAdapter } from './types';
import { listsAdapter } from './lists';
import { chartsAdapter } from './charts';
import { costAdapter } from './cost';

export const PACK: readonly EvidenceAdapter[] = [listsAdapter, chartsAdapter, costAdapter];
