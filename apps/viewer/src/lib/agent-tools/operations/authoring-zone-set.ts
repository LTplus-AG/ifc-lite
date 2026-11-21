/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';

/** Non-throwing: after an await, a deleted set reads as stale, not as an unknown id. */
export const findZoneSet = (id: string) => useViewerStore.getState().zoneSets.find(row => row.id === id);
