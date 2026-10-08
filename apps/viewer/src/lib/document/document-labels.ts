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

/** Paper uses standard PDF fonts: Intl's narrow nonbreaking grouping space
 * (e.g. French) needs their supported nonbreaking space before measuring.
 * Only generated numeric text is adapted; authored fields stay literal. */
export function capturedDocumentNumber(labels: DocumentLabelFormatter | undefined, value: number): string | undefined {
  return labels?.formatNumber?.(value).replaceAll('\u202f', '\u00a0');
}
