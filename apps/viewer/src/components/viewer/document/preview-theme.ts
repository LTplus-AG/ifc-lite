/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The document is a print preview, so its paper and ink intentionally do not
 * follow the surrounding viewer theme. Raw `bg-white` is theme-overridden. */
export const DOCUMENT_PREVIEW_PAPER_CLASS = 'document-preview-paper';

/** Fixed-paper secondary ink that clears WCAG AA without theme overrides. */
export const DOCUMENT_PREVIEW_MUTED_TEXT_CLASS = 'document-preview-muted';

/** Accessible UI paint on fixed white paper, without changing PDF ink or
 * authored colors/backgrounds (#6610). Gray 118 is the lightest integral
 * sRGB gray that clears 4.5:1 on white; lighter default ink uses our token. */
export function previewTextPaint(gray: number, authoredColor?: string, authoredBackground?: string) {
  if (authoredColor !== undefined || authoredBackground !== undefined || gray <= 118) {
    return { className: undefined, color: authoredColor ?? `rgb(${gray}, ${gray}, ${gray})` };
  }
  return { className: DOCUMENT_PREVIEW_MUTED_TEXT_CLASS, color: undefined };
}
