/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tabs in a document Text block (#6370). The editor inserts a real `\t`; the
 * preview draws it with CSS `tab-size: TAB_SIZE` and the PDF, whose standard
 * fonts have no tab glyph, turns it into spaces up to the same tab stop, so
 * the two agree on where indented text starts.
 */

/** Tab stop width in space-widths: CSS `tab-size` in the preview, the PDF's expansion here. */
export const TAB_SIZE = 4;

/**
 * The spaces a tab typed after `before` becomes: up to the next tab stop, a stop
 * every `TAB_SIZE` space-widths from the start of the output line, measured in
 * the line's own font — what the browser does for `tab-size` on a proportional
 * font. A stop the text already reached is passed, like a typewriter's: the tab
 * always moves right. `before` must be the text already on the same OUTPUT line,
 * so a tab after a wrap measures from the wrapped line's start, as the preview does.
 */
export function tabFill(before: string, measure: (text: string) => number): string {
  const space = measure(' ');
  if (!(space > 0)) return ' '.repeat(TAB_SIZE);
  const stop = space * TAB_SIZE;
  const width = measure(before);
  const next = (Math.floor(width / stop + 1e-6) + 1) * stop;
  return ' '.repeat(Math.max(1, Math.round((next - width) / space)));
}

export interface TextEdit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * What Tab (`outdent`: Shift+Tab) does to a text box's value, as in a word
 * processor: a caret or a selection inside one line becomes a tab; a
 * selection across lines, or any Shift+Tab, indents or outdents each touched
 * line and keeps the same text selected. `null` when there is nothing to do
 * (Shift+Tab on lines with no indent), so the caller can leave the key alone.
 */
export function tabEdit(text: string, selectionStart: number, selectionEnd: number, outdent: boolean): TextEdit | null {
  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);
  const multiLine = text.slice(start, end).includes('\n');
  if (!outdent && !multiLine) {
    return { text: `${text.slice(0, start)}\t${text.slice(end)}`, selectionStart: start + 1, selectionEnd: start + 1 };
  }
  const first = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  // A selection that ends right after a line break does not touch the next line.
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const lineEnd = text.indexOf('\n', last) === -1 ? text.length : text.indexOf('\n', last);
  const touched: Array<{ at: number; removed: number }> = [];
  let at = first;
  const edited = text.slice(first, lineEnd).split('\n').map((line) => {
    const removed = outdent ? (line.startsWith('\t') ? 1 : (/^ {1,4}/.exec(line)?.[0].length ?? 0)) : 0;
    touched.push({ at, removed });
    at += line.length + 1;
    return outdent ? line.slice(removed) : `\t${line}`;
  });
  if (outdent && touched.every((l) => l.removed === 0)) return null;
  // Where a position lands after the edit: every touched line at or before it shifts it by
  // its own change, and a position inside removed indentation moves to that line's new start.
  const map = (pos: number): number => touched.reduce(
    (moved, line) => (pos < line.at ? moved : moved + (outdent ? -Math.min(line.removed, pos - line.at) : 1)), pos);
  return {
    text: `${text.slice(0, first)}${edited.join('\n')}${text.slice(lineEnd)}`,
    selectionStart: map(start),
    selectionEnd: map(end),
  };
}
