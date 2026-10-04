/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComposeDocumentInput } from './compose.js';
import type { ResolvedBindingSpan } from './bindings.js';
import type { BindingMark } from './compose-table.js';
import type { TextFont } from './types.js';
import { tabFill } from './text-tabs.js';

export interface WrappedTextRow { text: string; bindingMarks?: BindingMark[] }

/** The one greedy wrap, with optional source positions for preview field
 * annotations. Tabs expand and wrap whitespace drops exactly as before;
 * annotations never add glyphs, widths, padding or a second wrapping pass. */
export function wrapTextRows(text: string, width: number, size: number, bold: boolean,
  measure: ComposeDocumentInput['measure'], font?: TextFont, bindings?: ResolvedBindingSpan[]): WrappedTextRow[] {
  const rows: WrappedTextRow[] = [];
  const annotated = !!bindings?.length;
  const fits = (line: string): boolean => measure(line, size, bold, font) <= width;
  const emit = (line: string, positions: number[]) => {
    const kept = line.trimEnd();
    const bindingMarks: BindingMark[] = [];
    const first = positions[0];
    const last = positions[kept.length - 1];
    const source = bindings ?? [];
    let low = 0;
    let high = source.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (source[middle].end <= first) low = middle + 1; else high = middle;
    }
    for (let b = low; b < source.length && source[b].start <= last; b++) {
      const binding = source[b];
      let start = -1;
      let end = -1;
      for (let i = 0; i < kept.length; i++) {
        if (positions[i] >= binding.start && positions[i] < binding.end) {
          if (start < 0) start = i;
          end = i + 1;
        }
      }
      if (start >= 0) bindingMarks.push({ start, end, unresolved: !binding.ok,
        tooltip: binding.ok ? `{${binding.path}}` : binding.reason });
    }
    rows.push({ text: kept, ...(bindingMarks.length ? { bindingMarks } : {}) });
  };
  const paragraphs = text.split(/\r\n?|\n/);
  const separators = [...text.matchAll(/\r\n?|\n/g)];
  let paragraphOffset = 0;
  paragraphs.forEach((paragraph, index) => {
    const offset = paragraphOffset;
    paragraphOffset += paragraph.length + (separators[index]?.[0].length ?? 0);
    if (!/\S/.test(paragraph)) { rows.push({ text: '' }); return; }
    let line = '';
    let positions: number[] = [];
    for (const match of paragraph.matchAll(/\t|[^\S\t]+|\S+/g)) {
      const token = match[0];
      const sourceOffset = offset + match.index;
      const tokenPositions = annotated ? Array.from({ length: token.length }, (_, i) => sourceOffset + i) : [];
      if (token === '\t') {
        const fill = tabFill(line, value => measure(value, size, bold, font));
        line += fill;
        if (annotated) positions.push(...Array<number>(fill.length).fill(sourceOffset));
        continue;
      }
      if (/^\s/.test(token) || fits(line + token)) {
        line += token;
        if (annotated) for (const position of tokenPositions) positions.push(position);
        continue;
      }
      if (line.trimEnd()) emit(line, positions);
      line = token;
      positions = tokenPositions;
      while (!fits(line) && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && !fits(line.slice(0, cut))) cut -= 1;
        emit(line.slice(0, cut), positions.slice(0, cut));
        line = line.slice(cut);
        positions = positions.slice(cut);
      }
    }
    emit(line, positions);
  });
  return rows;
}
