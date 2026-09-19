/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * New UI copy added to the Document panel's block editor by #4940 (chart
 * height, the shared chart/image width picker, the spacer block). The rest
 * of `BlockEditor.tsx` / `DocumentPanel.tsx` / `DocumentPreview.tsx` predate
 * the i18n sweep and are not converted here — see
 * `scripts/i18n-literals-baseline.json` for their unconverted counts.
 */
import type { TranslationValue } from '../types';

export const documentEn = {
  'document.block.widthLabel': 'Width',
  'document.block.widthAriaLabel': 'Block width',
  'document.block.widthTitle': 'Half pairs with the next half chart/image into one row',
  'document.block.widthFull': 'Full',
  'document.block.widthHalf': 'Half',
  'document.block.heightPtLabel': 'Height (pt)',
  'document.block.chartHeightAriaLabel': 'Chart height',
  'document.block.spacerHeightAriaLabel': 'Spacer height',
  'document.block.textStyleSubheading': 'Subheading',
  'document.block.textStyleSmall': 'Small',
  'document.block.textStyleCaption': 'Caption',
  'document.addBlock.spacer': 'Spacer',
} as const satisfies Record<string, TranslationValue>;
