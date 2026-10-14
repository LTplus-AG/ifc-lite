/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isPageQuoteOperand, isSpaceByte, opensComment, skipComment, skipTrivia } from './step-lexing.js';

// Record parameters only: do not apply this grammar to HEADER decoding.
// Caller checks PAGE and immediate doubled quotes first (#7540/#7541).
// 0 closes, -1 is malformed, -2 is unreadable trivia, positive is wrapped escape.
export function recordQuoteBoundary(buf: Uint8Array, quote: number): number {
  if (buf[quote + 1] === 0x2C || buf[quote + 1] === 0x29) return 0;
  let p = quote + 1;
  while (buf[p] === 0x0D || buf[p] === 0x0A) p++;
  if (p > quote + 1 && buf[p] === 0x27) return p + 1;
  const trivia = skipTrivia(buf, quote + 1, buf.length);
  if (trivia.stop) return -2;
  return buf[trivia.next] === 0x2C || buf[trivia.next] === 0x29 ? 0 : -1;
}

/** Recover only after a delimiter-confirmed end of damaged quoted text.
 * Complete later quoted parameters are skipped, so their '#...' is not an
 * entity. Ambiguous/unclosed later values refuse the remainder (#7541).
 */
export function nextRecordAfterBadQuote(buf: Uint8Array, quote: number): number {
  let p = quote + 1;
  let knownOutside = false, parameterStart = false, anchored = false;
  while (p < buf.length) {
    const b = buf[p];
    if (!knownOutside) {
      if (b !== 0x27) { p++; continue; }
      if (isPageQuoteOperand(buf, p)) { p++; continue; }
      if (buf[p + 1] === 0x27) { p += 2; continue; }
      const boundary = recordQuoteBoundary(buf, p);
      if (boundary === -2) return buf.length;
      if (boundary === 0) { knownOutside = true; p++; }
      else p = boundary > 0 ? boundary : p + 1;
    } else if (b === 0x27) {
      if (!parameterStart) return buf.length;
      const end = skipRecordString(buf, p);
      if (end < 0) return buf.length;
      p = end;
      parameterStart = false;
      anchored = false;
    } else if (opensComment(buf, p, buf.length)) {
      const end = skipComment(buf, p, buf.length);
      if (end < 0) return buf.length;
      for (let i = p; i < end; i++) {
        if (buf[i] === 0x0D || buf[i] === 0x0A) anchored = true;
      }
      p = end;
    } else if (b === 0x23 && anchored) {
      const start = p++;
      const digits = p;
      while (buf[p] >= 0x30 && buf[p] <= 0x39) p++;
      if (p === digits) { anchored = false; parameterStart = false; continue; }
      const trivia = skipTrivia(buf, p, buf.length);
      if (trivia.stop) return buf.length;
      if (buf[trivia.next] === 0x3D) return start;
      anchored = trivia.lines > 0;
      parameterStart = false;
      p = trivia.next;
    } else {
      if (b === 0x0D || b === 0x0A || b === 0x3B) anchored = true;
      else if (!isSpaceByte(b)) anchored = false;
      if (!isSpaceByte(b)) parameterStart = b === 0x28 || b === 0x2C;
      p++;
    }
  }
  return buf.length;
}

/** Balanced/cold scanners refuse malformed quoted values rather than resync. */
export function skipRecordString(buf: Uint8Array, opening: number): number {
  let p = opening + 1;
  while (p < buf.length) {
    if (buf[p] !== 0x27) { p++; continue; }
    if (isPageQuoteOperand(buf, p)) { p++; continue; }
    if (buf[p + 1] === 0x27) { p += 2; continue; }
    const boundary = recordQuoteBoundary(buf, p);
    if (boundary < 0) return -1;
    if (boundary === 0) return p + 1;
    p = boundary;
  }
  return -1;
}
