/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Glyph safety for the PDF standard fonts (#6918). Documents print with the
 * 14 standard fonts, which encode WinAnsi (Windows-1252) only: German umlauts,
 * French accents and the usual typographic marks are safe, while arrows,
 * many Central European letters and non-Latin scripts would print as wrong
 * glyphs. Text is made printable before it enters a document so the preview
 * shows exactly what the PDF prints, and every substitution is reported.
 */

import { encodeDxfCp1252 } from '@ifc-lite/drawing-2d';

/** Printable in WinAnsi: tab, newline and every non-control character windows-1252 encodes (one shared encoder). */
export function isStandardFontChar(char: string): boolean {
  if (char === '\n' || char === '\t') return true;
  const code = char.codePointAt(0)!;
  return code >= 0x20 && code !== 0x7f && !encodeDxfCp1252(char).hadUnmappable;
}

/** Plain-text spellings for symbols models and IFC files commonly carry. */
const SUBSTITUTES: Record<string, string> = {
  '↔': '<->', '→': '->', '←': '<-', '⇒': '=>', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '−': '-', '‐': '-', '‑': '-',
  '‒': '-', '\u2009': ' ', '\u202f': ' ', '\u200b': '', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ħ': 'h',
  'ı': 'i', 'ŀ': 'l', 'Δ': 'Delta', '∆': 'Delta', '√': 'sqrt', '∞': 'infinity', '✓': 'yes', '✔': 'yes', '✗': 'no',
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '⁴': '4', '′': "'", '″': '"', '❝': '"', '❞': '"',
};

export interface StandardFontText {
  text: string;
  /** Original character → printable spelling, for characters rewritten without loss of meaning. */
  transliterated: Map<string, string>;
  /** Characters with no printable spelling; each became `?`. */
  replaced: Map<string, number>;
}

function spell(char: string): string | null {
  if (isStandardFontChar(char)) return char;
  if (Object.hasOwn(SUBSTITUTES, char)) return SUBSTITUTES[char];
  // Latin letters with diacritics outside WinAnsi (č, ő, ą, ș …) keep their base letter.
  const base = char.normalize('NFD').replace(/\p{M}+/gu, '');
  if (base !== char && base.length > 0 && [...base].every(isStandardFontChar)) return base;
  return null;
}

/** Printable text plus an account of every change; `\r` is normalized away. */
export function toStandardFontText(input: string): StandardFontText {
  const transliterated = new Map<string, string>();
  const replaced = new Map<string, number>();
  let text = '';
  for (const char of input.replace(/\r\n?/g, '\n').normalize('NFC')) {
    const spelled = spell(char);
    if (spelled === char) text += char;
    else if (spelled !== null) { text += spelled; transliterated.set(char, spelled); }
    else { text += '?'; replaced.set(char, (replaced.get(char) ?? 0) + 1); }
  }
  return { text, transliterated, replaced };
}

/** Share of non-space characters in `input` that have no printable spelling at all. */
export function unprintableShare(input: string): number {
  const letters = input.replace(/\s/g, '').length;
  const replaced = [...toStandardFontText(input).replaced.values()].reduce((sum, count) => sum + count, 0);
  return letters ? replaced / letters : 0;
}

/** Collects substitutions over many texts for one visible notice. */
export class StandardFontLedger {
  readonly transliterated = new Map<string, string>();
  readonly replaced = new Map<string, number>();

  print(input: string): string {
    const result = toStandardFontText(input);
    for (const [char, spelled] of result.transliterated) this.transliterated.set(char, spelled);
    for (const [char, count] of result.replaced) this.replaced.set(char, (this.replaced.get(char) ?? 0) + count);
    return result.text;
  }

  /** Printable notice text, or null when nothing changed. Names characters by code point so the notice itself prints. */
  notice(): string | null {
    const code = (char: string) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
    const parts: string[] = [];
    if (this.transliterated.size) {
      parts.push(`Transliterated for the standard PDF fonts: ${[...this.transliterated].map(([char, spelled]) => `${code(char)} as "${spelled}"`).join(', ')}.`);
    }
    if (this.replaced.size) {
      parts.push(`Not printable in the standard PDF fonts and replaced by "?": ${[...this.replaced].map(([char, count]) => `${code(char)} (${count}x)`).join(', ')}.`);
    }
    return parts.length ? parts.join('\n') : null;
  }
}
