/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TextFont, DocumentValidationError } from './types.js';
import { truncateToWidth } from './text-layout.js';
import { REPORT_MARGIN } from '../export/report/compose.js';
import { validateTextTypography } from './text-typography.js';

export interface PageHeading {
  text?: string;
  font?: TextFont;
  fontSize?: number;
  textColor?: string;
}

export interface ResolvedPageHeading {
  text: string; font: TextFont; fontSize: number; textColor: string; y: number; extraHeight: number;
}

export const PAGE_HEADING_DEFAULTS = { font: 'helvetica' as const, fontSize: 8, textColor: '#969696' };

export function pageHeadingStyle(heading: PageHeading = {}) {
  const font = heading.font ?? PAGE_HEADING_DEFAULTS.font;
  const fontSize = heading.fontSize ?? PAGE_HEADING_DEFAULTS.fontSize;
  return { font, fontSize, textColor: heading.textColor ?? PAGE_HEADING_DEFAULTS.textColor,
    extraHeight: Math.max(0, fontSize - PAGE_HEADING_DEFAULTS.fontSize) };
}

/** Same bounded one-line heading and reserved space for each printed page. */
export function resolvePageHeading(name: string, heading: PageHeading, width: number,
  measure: (text: string, size: number, bold: boolean, font?: TextFont) => number): ResolvedPageHeading {
  const style = pageHeadingStyle(heading);
  const { font, fontSize, extraHeight } = style;
  const text = (heading.text ?? name).replace(/[\r\n\t]+/g, ' ');
  return { ...style, text: truncateToWidth(text, width, fontSize, false, (value, size, bold) => measure(value, size, bold, font)),
    y: REPORT_MARGIN - PAGE_HEADING_DEFAULTS.fontSize + extraHeight };
}

export function validatePageHeading(value: unknown): DocumentValidationError[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ path: 'pageHeading', message: 'expected an object' }];
  const heading = value as Record<string, unknown>;
  const errors: DocumentValidationError[] = [];
  if (heading.text !== undefined && typeof heading.text !== 'string') errors.push({ path: 'pageHeading.text', message: 'expected a string' });
  errors.push(...validateTextTypography(heading, 'pageHeading'));
  return errors;
}
