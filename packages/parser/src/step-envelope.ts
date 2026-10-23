/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isKeywordLeadByte, isSpaceByte, opensLiteralOrComment, skipLexical, skipTrivia } from './step-lexing.js';

/** Check section markers in their lexical context without decoding the whole file. */
export function inspectStepEnvelope(bytes: Uint8Array): { data: boolean; footer: boolean } {
  const len = bytes.length;
  let depth = 0;
  let header = false;
  let headerEnded = false;
  let data = false;
  let lastSyntax = 59;
  const keyword = (at: number, word: string): number => {
    if (at > 0 && (isKeywordLeadByte(bytes[at - 1]) || (bytes[at - 1] >= 48 && bytes[at - 1] <= 57) || bytes[at - 1] === 95)) return -1;
    for (let j = 0; j < word.length; j++) if (bytes[at + j] !== word.charCodeAt(j)) return -1;
    const after = skipTrivia(bytes, at + word.length, len);
    return !after.stop && bytes[after.next] === 59 ? after.next + 1 : -1;
  };
  for (let i = 0; i < len;) {
    if (opensLiteralOrComment(bytes, i, len)) {
      const skip = skipLexical(bytes, i, len);
      if (skip.stop) return { data, footer: false };
      if (bytes[i] === 39) lastSyntax = 39;
      i = skip.next;
      continue;
    }
    const byte = bytes[i];
    if (byte === 40) depth++;
    else if (byte === 41) depth--;
    if (depth === 0 && lastSyntax === 59) {
      let end: number;
      if (byte === 72 && (end = keyword(i, 'HEADER')) >= 0) { header = true; lastSyntax = 59; i = end; continue; }
      if (byte === 69 && (end = keyword(i, 'ENDSEC')) >= 0) {
        if (header) { header = false; headerEnded = true; }
        lastSyntax = 59; i = end;
        continue;
      }
      if (byte === 68 && headerEnded && !header && (end = keyword(i, 'DATA')) >= 0) {
        data = true; lastSyntax = 59; i = end; continue;
      }
      if (byte === 69 && (end = keyword(i, 'END-ISO-10303-21')) >= 0) {
        const tail = skipTrivia(bytes, end, len);
        return { data, footer: !tail.stop && tail.next === len };
      }
    }
    if (!isSpaceByte(byte)) lastSyntax = byte;
    i++;
  }
  return { data, footer: false };
}
