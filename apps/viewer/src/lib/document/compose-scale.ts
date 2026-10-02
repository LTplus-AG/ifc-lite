/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { REPORT_MARGIN } from '../export/report/compose.js';

export const HEADER_HEIGHT = 30;
export const FOOTER_HEIGHT = 24;

/**
 * Page height a block laid out at `scale` sees (#6548). A scaled block is laid out as if the
 * printable frame were `1 / scale` as tall and wide and then drawn `scale` times larger, so the
 * frame shrinks while the margins, header and footer around it do not.
 */
export function scaledPageHeight(pageHeight: number, headingExtraHeight: number, scale: number): number {
  const fixed = 2 * REPORT_MARGIN + HEADER_HEIGHT + FOOTER_HEIGHT + headingExtraHeight;
  return fixed + (pageHeight - fixed) / scale;
}
