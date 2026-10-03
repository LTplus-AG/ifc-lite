/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DocumentValidationError, TextFont } from './types.js';
import { validateTextTypography } from './text-typography.js';

export interface PageBandLogo { dataUrl: string; height: number }
export interface PageBand {
  text?: string;
  font?: TextFont;
  fontSize?: number;
  textColor?: string;
  logo?: PageBandLogo;
  showDate?: boolean;
  showPageNumbers?: boolean;
}

export const PAGE_LOGO_HEIGHT_MIN = 8;
export const PAGE_LOGO_HEIGHT_MAX = 96;
export const PAGE_LOGO_HEIGHT_DEFAULT = 32;
export const isDocumentImageDataUrl = (value: unknown): value is string => typeof value === 'string' && /^data:image\/(png|jpeg);base64,/.test(value);

export function validatePageBand(value: unknown, path: string): DocumentValidationError[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ path, message: 'expected an object' }];
  const band = value as Record<string, unknown>;
  const errors = validateTextTypography(band, path);
  if (band.text !== undefined && typeof band.text !== 'string') errors.push({ path: `${path}.text`, message: 'expected a string' });
  for (const field of ['showDate', 'showPageNumbers']) if (band[field] !== undefined && typeof band[field] !== 'boolean') {
    errors.push({ path: `${path}.${field}`, message: 'expected a boolean' });
  }
  if (band.logo !== undefined) {
    const logo = band.logo;
    if (typeof logo !== 'object' || logo === null || Array.isArray(logo)) errors.push({ path: `${path}.logo`, message: 'expected an object' });
    else {
      const asset = logo as Record<string, unknown>;
      if (!isDocumentImageDataUrl(asset.dataUrl)) errors.push({ path: `${path}.logo.dataUrl`, message: 'expected a PNG or JPEG data URL' });
      if (typeof asset.height !== 'number' || !Number.isFinite(asset.height) || asset.height < PAGE_LOGO_HEIGHT_MIN || asset.height > PAGE_LOGO_HEIGHT_MAX) {
        errors.push({ path: `${path}.logo.height`, message: `expected a number between ${PAGE_LOGO_HEIGHT_MIN} and ${PAGE_LOGO_HEIGHT_MAX}` });
      }
    }
  }
  return errors;
}

export function pageBandImageUrls(document: { pageHeading?: PageBand; pageFooter?: PageBand }): string[] {
  return [...new Set([document.pageHeading?.logo?.dataUrl, document.pageFooter?.logo?.dataUrl].filter((url): url is string => !!url))];
}

/** The same asset measure and square failure policy as an ordinary document image. */
export async function pageBandImageAspects(document: { pageHeading?: PageBand; pageFooter?: PageBand },
  measure: (dataUrl: string) => Promise<{ w: number; h: number }>): Promise<ReadonlyMap<string, number>> {
  const aspects = new Map<string, number>();
  for (const url of pageBandImageUrls(document)) {
    let aspect = 1;
    try { const size = await measure(url); if (size.w > 0 && size.h > 0) aspect = size.w / size.h; }
    catch (error) { console.warn('[Documents] page logo could not be measured; printed square', error); }
    aspects.set(url, aspect);
  }
  return aspects;
}
