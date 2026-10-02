/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { resolveEnglish } from '@/i18n/registry';

/** A captured catalogue formats paper labels before measurement and wrapping.
 * Omitted by existing headless callers, which retain the canonical English labels. */
export type DocumentLabelFormatter = typeof resolveEnglish & {
  /** Bound to the same captured locale as the catalogue; absent keeps direct-export defaults. */
  readonly formatNumber?: (value: number) => string;
};
