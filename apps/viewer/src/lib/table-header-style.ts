/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One opaque table-header palette for document preview and every PDF chunk (#6489). */
import { isRgbColor, contrastRatio } from './color-contrast';

export interface TableHeaderStyle { backgroundColor: string; textColor: '#000000' | '#ffffff' }
export const DEFAULT_TABLE_HEADER_BACKGROUND = '#334155';

export function tableHeaderStyle(background?: string): TableHeaderStyle {
  const backgroundColor = isRgbColor(background) ? background : DEFAULT_TABLE_HEADER_BACKGROUND;
  const rgb = [1, 3, 5].map((start) => Number.parseInt(backgroundColor.slice(start, start + 2), 16) / 255);
  // The better of opaque black/white always meets WCAG AA body-text contrast.
  const textColor = contrastRatio(rgb, [0, 0, 0]) >= contrastRatio(rgb, [1, 1, 1]) ? '#000000' : '#ffffff';
  return { backgroundColor, textColor };
}
