/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Recent rule sets": the last few `.rules.json` files opened or saved from
 * `ValidationPanel` (#5138 plan §6). The cache mechanics are shared with
 * the manual-validation checklists (#6401) in `recent-files.ts`.
 */

import { createRecentFileCache, type RecentFile } from './recent-files.js';

export type RecentRuleSet = RecentFile;

const cache = createRecentFileCache('ifc-lite:validation:recent-rule-sets', 'recent rule sets');

export const loadRecentRuleSets = cache.load;
export const addRecentRuleSet = cache.add;
export const removeRecentRuleSet = cache.remove;
