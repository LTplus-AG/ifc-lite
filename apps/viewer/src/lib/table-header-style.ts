/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared opaque document-table palette for preview and every PDF header (#6489, #6543). */
import { isRgbColor, contrastRatio } from './color-contrast';

export interface TableHeaderStyle { backgroundColor: string; textColor: string }
export const DEFAULT_TABLE_HEADER_BACKGROUND = '#334155';

export function tableHeaderStyle(background?: string, textColorOverride?: string): TableHeaderStyle {
  const backgroundColor = isRgbColor(background) ? background : DEFAULT_TABLE_HEADER_BACKGROUND;
  const rgb = [1, 3, 5].map((start) => Number.parseInt(backgroundColor.slice(start, start + 2), 16) / 255);
  // The automatic choice uses whichever of opaque black/white better meets WCAG AA body-text contrast; authored ink wins.
  const textColor = isRgbColor(textColorOverride) ? textColorOverride
    : contrastRatio(rgb, [0, 0, 0]) >= contrastRatio(rgb, [1, 1, 1]) ? '#000000' : '#ffffff';
  return { backgroundColor, textColor };
}
