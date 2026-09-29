/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** "Recent checklists": the last few `.checklist.json` templates opened or
 *  saved from the Manual validation tab (#6401), cached like rule sets. */

import { createRecentFileCache, type RecentFile } from '../recent-files.js';

export type RecentChecklist = RecentFile;

const cache = createRecentFileCache('ifc-lite:validation:recent-checklists', 'recent checklists');

export const loadRecentChecklists = cache.load;
export const addRecentChecklist = cache.add;
export const removeRecentChecklist = cache.remove;
