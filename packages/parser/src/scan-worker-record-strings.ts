/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Blob transport mirror of step-record-strings.ts, checked through assembled worker controls. */
export const WORKER_RECORD_STRINGS = `
  function recordQuoteBoundaryAt(q) {
    if (buf[q + 1] === 0x2C || buf[q + 1] === 0x29) return 0;
    var p = q + 1;
    while (buf[p] === 0x0D || buf[p] === 0x0A) p++;
    if (p > q + 1 && buf[p] === 0x27) return p + 1;
    var saved = line;
    p = skipTriviaAt(q + 1);
    line = saved;
    if (p < 0) return -2;
    return buf[p] === 0x2C || buf[p] === 0x29 ? 0 : -1;
  }
  function skipRecordStringAt(opening) {
    var p = opening + 1;
    while (p < len) {
      if (buf[p] !== 0x27) { p++; continue; }
      if (isPageQuoteOperandAt(p)) { p++; continue; }
      if (buf[p + 1] === 0x27) { p += 2; continue; }
      var boundary = recordQuoteBoundaryAt(p);
      if (boundary < 0) return -1;
      if (boundary === 0) return p + 1;
      p = boundary;
    }
    return -1;
  }
  function nextRecordAfterBadQuoteAt(q) {
    var p = q + 1, knownOutside = false, parameterStart = false, anchored = false;
    while (p < len) {
      var b = buf[p];
      if (!knownOutside) {
        if (b !== 0x27) { p++; continue; }
        if (isPageQuoteOperandAt(p)) { p++; continue; }
        if (buf[p + 1] === 0x27) { p += 2; continue; }
        var boundary = recordQuoteBoundaryAt(p);
        if (boundary === -2) return len;
        if (boundary === 0) { knownOutside = true; p++; }
        else p = boundary > 0 ? boundary : p + 1;
      } else if (b === 0x27) {
        if (!parameterStart) return len;
        var end = skipRecordStringAt(p);
        if (end < 0) return len;
        p = end; parameterStart = false; anchored = false;
      } else if (opensCommentAt(p)) {
        var saved = line, end = skipCommentAt(p);
        line = saved;
        if (end < 0) return len;
        for (var i = p; i < end; i++) if (buf[i] === 0x0D || buf[i] === 0x0A) anchored = true;
        p = end;
      } else if (b === 0x23 && anchored) {
        var start = p++, digits = p;
        while (buf[p] >= 0x30 && buf[p] <= 0x39) p++;
        if (p === digits) { anchored = false; parameterStart = false; continue; }
        var saved = line, end = skipTriviaAt(p);
        line = saved;
        if (end < 0) return len;
        if (buf[end] === 0x3D) return start;
        anchored = false; parameterStart = false;
        for (var i = p; i < end; i++) if (buf[i] === 0x0D || buf[i] === 0x0A) anchored = true;
        p = end;
      } else {
        if (b === 0x0D || b === 0x0A || b === 0x3B) anchored = true;
        else if (!isSpaceByteAt(p)) anchored = false;
        if (!isSpaceByteAt(p)) parameterStart = b === 0x28 || b === 0x2C;
        p++;
      }
    }
    return len;
  }
`;
