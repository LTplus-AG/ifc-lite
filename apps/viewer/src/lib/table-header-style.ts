/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared opaque document-table palette for preview and every PDF header (#6489, #6543). */
import { isRgbColor, contrastRatio, rgbChannels } from './color-contrast';

export interface TableHeaderStyle { backgroundColor: string; textColor: string }
export const DEFAULT_TABLE_HEADER_BACKGROUND = '#334155';

/** Opaque black or white, whichever of the two meets the higher WCAG contrast on `background` (`#RRGGBB`). */
export function readableInkOn(background: string): '#000000' | '#ffffff' {
  const rgb = rgbChannels(background);
  return contrastRatio(rgb, [0, 0, 0]) >= contrastRatio(rgb, [1, 1, 1]) ? '#000000' : '#ffffff';
}

export function tableHeaderStyle(background?: string, textColorOverride?: string): TableHeaderStyle {
  const backgroundColor = isRgbColor(background) ? background : DEFAULT_TABLE_HEADER_BACKGROUND;
  // The automatic choice uses whichever of opaque black/white better meets WCAG AA body-text contrast; authored ink wins.
  const textColor = isRgbColor(textColorOverride) ? textColorOverride : readableInkOn(backgroundColor);
  return { backgroundColor, textColor };
}
