/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * English catalogues that load with their feature's chunk instead of the
 * page's first load (#6923). A feature module registers its catalogue with
 * `registerEnglish` when it is imported, before it renders; only
 * the key TYPES are referenced here, so nothing of these catalogues is
 * bundled eagerly.
 */

import type { flowReviewEn } from './catalogues/flow-review.en';

export type LazyTranslationKey = keyof typeof flowReviewEn;

