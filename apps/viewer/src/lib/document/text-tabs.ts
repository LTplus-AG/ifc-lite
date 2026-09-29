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
 * Replace each tab with spaces up to the next tab stop, a stop every
 * `TAB_SIZE` space-widths from the start of the line, measured in the line's
 * own font: what the browser does for `tab-size` on a proportional font.
 */
export function expandTabs(line: string, measure: (text: string) => number): string {
  if (!line.includes('\t')) return line;
  const space = measure(' ');
  if (!(space > 0)) return line.replaceAll('\t', ' '.repeat(TAB_SIZE));
  const stop = space * TAB_SIZE;
  let out = '';
  for (const part of line.split(/(\t)/)) {
    if (part !== '\t') { out += part; continue; }
    const width = measure(out);
    // A stop the text already reached is passed, like a typewriter's: the tab always moves right.
    const next = (Math.floor(width / stop + 1e-6) + 1) * stop;
    out += ' '.repeat(Math.max(1, Math.round((next - width) / space)));
  }
  return out;
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
  let shiftStart = 0;
  let shiftTotal = 0;
  const edited = text.slice(first, lineEnd).split('\n').map((line, i) => {
    const removed = outdent ? (line.startsWith('\t') ? 1 : (/^ {1,4}/.exec(line)?.[0].length ?? 0)) : 0;
    const delta = outdent ? -removed : 1;
    if (i === 0) shiftStart = outdent ? -Math.min(removed, start - first) : delta;
    shiftTotal += delta;
    return outdent ? line.slice(removed) : `\t${line}`;
  });
  if (shiftTotal === 0) return null;
  return {
    text: `${text.slice(0, first)}${edited.join('\n')}${text.slice(lineEnd)}`,
    selectionStart: start + shiftStart,
    selectionEnd: Math.max(start + shiftStart, end + shiftTotal),
  };
}
