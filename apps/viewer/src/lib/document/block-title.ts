/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DocumentValidationError } from './types.js';

/** Authored presentation belongs to the document, independently of its source (#6547). */
export interface BlockTitle {
  title?: string;
}

/** Headings occupy one line; preserve the authored value and normalize only its display. */
export function blockTitle(block: BlockTitle, fallback = '', singleLine = true): string {
  const authored = block.title?.trim() ?? '';
  // Existing table titles retain their pre-#6547 line-break behavior.
  return (singleLine ? authored.replace(/\s*[\r\n]+\s*/g, ' ') : authored) || fallback;
}

export function validateBlockTitle(block: Record<string, unknown>, at: string, errors: DocumentValidationError[]): void {
  if (block.title !== undefined && typeof block.title !== 'string') errors.push({ path: `${at}.title`, message: 'expected a string' });
}

/** Additional heading space for content that previously had no heading. */
export const BLOCK_TITLE_HEIGHT = 16;
