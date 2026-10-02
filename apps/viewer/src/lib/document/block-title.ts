/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isRgbColor } from '../color-contrast';
import { readableInkOn } from '../table-header-style';
import type { DocumentValidationError } from './types.js';

/** Heading text size in points: absent prints the default; the bounds match the chart text size (6-24). */
export const BLOCK_TITLE_SIZE_MIN = 6;
export const BLOCK_TITLE_SIZE_MAX = 24;
export const BLOCK_TITLE_SIZE_DEFAULT = 11;

/** How the heading looks, shared by every block kind that has one (#6632). Absent fields print as before. */
export interface BlockHeaderStyleFields {
  /** Heading text size, `BLOCK_TITLE_SIZE_MIN`-`BLOCK_TITLE_SIZE_MAX` points. */
  titleFontSize?: number;
  /** Heading ink in `#RRGGBB`; absent is black, or black/white by contrast when a background is set. */
  titleTextColor?: string;
  /** Heading strip background in `#RRGGBB`; absent is transparent paper. */
  titleBackgroundColor?: string;
}

/** Authored presentation belongs to the document, independently of its source (#6547). */
export interface BlockTitle extends BlockHeaderStyleFields {
  title?: string;
}

const HEADER_STYLE_KEYS = ['titleFontSize', 'titleTextColor', 'titleBackgroundColor'] as const;

/**
 * Every heading field of `block`, unset ones as explicit `undefined`: spread this where a block's source
 * is replaced (refresh from a report, choosing a saved report) so the destination keeps the authored
 * heading and a field cleared on it is not resurrected from the replacement.
 */
export function blockTitleFields(block: BlockTitle): { title: string | undefined; titleFontSize: number | undefined; titleTextColor: string | undefined; titleBackgroundColor: string | undefined } {
  return { title: block.title, titleFontSize: block.titleFontSize, titleTextColor: block.titleTextColor, titleBackgroundColor: block.titleBackgroundColor };
}

/** Only the heading fields that are set: for a block built over a snapshot whose own values must survive an unset field. */
export function setBlockTitleFields(block: BlockTitle): BlockTitle {
  return { ...(block.title !== undefined ? { title: block.title } : {}), ...blockHeaderStyleFields(block) };
}

/** Only the style fields that are set, for resolved blocks that carry their heading text separately. */
export function blockHeaderStyleFields(block: BlockHeaderStyleFields): BlockHeaderStyleFields {
  const out: BlockHeaderStyleFields = {};
  for (const key of HEADER_STYLE_KEYS) if (block[key] !== undefined) Object.assign(out, { [key]: block[key] });
  return out;
}

export interface BlockTitleStyle {
  /** Point size at the default block scale. */
  size: number;
  /** Height added to the heading strip over the default one, in points; never negative. */
  extra: number;
  textColor?: string;
  backgroundColor?: string;
}

/**
 * The one reading of a block's heading style, used by every composer and by the preview.
 * `defaultSize` is the size the kind prints with no override (a chart's follows its text size).
 * Invalid values read as absent, like `blockScale`.
 */
export function blockTitleStyle(block: BlockHeaderStyleFields, defaultSize = BLOCK_TITLE_SIZE_DEFAULT): BlockTitleStyle {
  const authored = block.titleFontSize;
  const size = typeof authored === 'number' && Number.isFinite(authored) && authored >= BLOCK_TITLE_SIZE_MIN && authored <= BLOCK_TITLE_SIZE_MAX ? authored : defaultSize;
  const backgroundColor = isRgbColor(block.titleBackgroundColor) ? block.titleBackgroundColor : undefined;
  // Authored ink wins; with only a background the ink is whichever of black/white contrasts better, never the default black.
  const textColor = isRgbColor(block.titleTextColor) ? block.titleTextColor : backgroundColor ? readableInkOn(backgroundColor) : undefined;
  return { size, extra: Math.max(0, size - defaultSize) * (BLOCK_TITLE_HEIGHT / BLOCK_TITLE_SIZE_DEFAULT), ...(textColor ? { textColor } : {}), ...(backgroundColor ? { backgroundColor } : {}) };
}

/** Headings occupy one line; preserve the authored value and normalize only its display. */
export function blockTitle(block: BlockTitle, fallback = '', singleLine = true): string {
  const authored = block.title?.trim() ?? '';
  // Existing table titles retain their pre-#6547 line-break behavior.
  return (singleLine ? authored.replace(/\s*[\r\n]+\s*/g, ' ') : authored) || fallback;
}

export function validateBlockTitle(block: Record<string, unknown>, at: string, errors: DocumentValidationError[]): void {
  if (block.title !== undefined && typeof block.title !== 'string') errors.push({ path: `${at}.title`, message: 'expected a string' });
  const size = block.titleFontSize;
  if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size) || size < BLOCK_TITLE_SIZE_MIN || size > BLOCK_TITLE_SIZE_MAX)) {
    errors.push({ path: `${at}.titleFontSize`, message: `expected a number between ${BLOCK_TITLE_SIZE_MIN} and ${BLOCK_TITLE_SIZE_MAX}` });
  }
  for (const key of ['titleTextColor', 'titleBackgroundColor'] as const) {
    if (block[key] !== undefined && !isRgbColor(block[key])) errors.push({ path: `${at}.${key}`, message: 'expected an RGB colour in #RRGGBB form' });
  }
}

/** Additional heading space for content that previously had no heading. */
export const BLOCK_TITLE_HEIGHT = 16;
