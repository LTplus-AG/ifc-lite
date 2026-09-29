/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Model workspace's kind variants (charter #6232, lane A2): the interim
 * `space.place` command, until the M4 Room tool supersedes it.
 */
export const kindVariantsEn = {
  'kindVariants.space.label': 'Space',
  'kindVariants.space.palette': 'Draw spaces',
} as const satisfies Record<string, TranslationValue>;
