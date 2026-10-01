/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isRgbColor } from '../color-contrast.js';
import type { DocumentValidationError } from './types.js';

export type TextFont = 'helvetica' | 'times' | 'courier';
export const TEXT_SIZE_MIN = 6;
export const TEXT_SIZE_MAX = 48;
export const DOCUMENT_FONT_FAMILIES: Record<TextFont, string> = {
  helvetica: 'Helvetica, Arial, sans-serif', times: 'Times New Roman, serif', courier: 'Courier New, monospace',
};

/** Standard PDF fonts and optional RGB ink, shared by text blocks and page headings. */
export function validateTextTypography(value: Record<string, unknown>, path: string): DocumentValidationError[] {
  const errors: DocumentValidationError[] = [];
  if (value.font !== undefined && value.font !== 'helvetica' && value.font !== 'times' && value.font !== 'courier') errors.push({ path: `${path}.font`, message: 'expected helvetica | times | courier' });
  if (value.fontSize !== undefined && (typeof value.fontSize !== 'number' || !Number.isFinite(value.fontSize) || value.fontSize < TEXT_SIZE_MIN || value.fontSize > TEXT_SIZE_MAX)) errors.push({ path: `${path}.fontSize`, message: `expected a number between ${TEXT_SIZE_MIN} and ${TEXT_SIZE_MAX}` });
  if (value.textColor !== undefined && !isRgbColor(value.textColor)) errors.push({ path: `${path}.textColor`, message: 'expected an RGB colour in #RRGGBB form' });
  return errors;
}
