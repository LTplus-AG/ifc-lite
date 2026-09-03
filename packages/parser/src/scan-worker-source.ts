/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scan worker's source, as a string.
 *
 * Split from `scan-worker-inline.ts`, which owns the Blob/Worker plumbing and
 * the result decoding. The scanner is a string because a Blob worker cannot
 * import at runtime, so this file is the one place the third copy of the STEP
 * scan rules lives -- see the comments inside for which `step-lexing.ts`
 * function each mirrors.
 */

import { MAX_EXPRESS_ID } from './express-id.js';

/**
 * Self-contained entity scanner code (runs inside Web Worker).
 * This is the same algorithm as StepTokenizer.scanEntitiesFast() but
 * written as a standalone function for worker embedding.
 */
/** Exported for direct testing (run inside a mock `self`); the runtime path
 *  wraps it in a Blob worker in `scan-worker-inline.ts`. */
export const WORKER_CODE = `
'use strict';
self.onmessage = function(e) {
  var buf = new Uint8Array(e.data);
  var len = buf.length;
  var pos = 0;
  var line = 1;

  // Pre-allocate result array (estimate ~13,500 entities per MB)
  var estimatedCount = Math.max((len / 1024 / 1024) * 13500, 1000) | 0;
  // Pack results into typed arrays for fast transfer. Uint32Array for the ids:
  // that is the express-id storage contract every consumer of this scan holds
  // to (CompactEntityIndex, the entity/property/quantity tables, the wasm
  // boundary, Rust's ColumnarIndex), so the guard below refuses anything wider
  // rather than carrying it one buffer further and truncating downstream
  // (#3395). The worker runs from a Blob URL and cannot import at runtime, so
  // the bound below is interpolated from express-id.ts when this template is
  // evaluated -- one home for the number, not a copy that can drift.
  // Whether a STEP comment opens at p.
  function opensCommentAt(p) {
    return p + 1 < len && buf[p] === 0x2F && buf[p + 1] === 0x2A;
  }

  // Index just past the '*/' closing the comment at p, or -1 when it never
  // closes. Counts the newlines it crosses so line numbers stay in step.
  //
  // Kept behaviourally identical to skipComment/skipTrivia in step-lexing.ts,
  // which this cannot import: the worker source is a string, so this copy of
  // the rule has to live here. Comments do not nest, per ISO 10303-21.
  function skipCommentAt(p) {
    var q = p + 2;
    while (q + 1 < len) {
      if (buf[q] === 0x2A && buf[q + 1] === 0x2F) return q + 2;
      if (buf[q] === 0x0A) line++;
      q++;
    }
    return -1;
  }

  // Skip whitespace, comments, and any run of the two -- 10303-21 allows a
  // comment wherever whitespace is allowed, INCLUDING inside a record.
  // Returns -1 when a comment opens and never closes: everything from there on
  // is inside it, so there is nothing left to find.
  function skipTriviaAt(p) {
    for (;;) {
      while (p < len) {
        var t = buf[p];
        if (t === 0x20 || t === 0x09 || t === 0x0D) { p++; }
        else if (t === 0x0A) { line++; p++; }
        else break;
      }
      if (!opensCommentAt(p)) return p;
      var e = skipCommentAt(p);
      if (e < 0) return -1;
      p = e;
    }
  }

  var ids = new Uint32Array(estimatedCount);
  var offsets = new Uint32Array(estimatedCount);
  var lengths = new Uint32Array(estimatedCount);
  var lines = new Uint32Array(estimatedCount);
  // Type names stored separately (strings)
  var types = new Array(estimatedCount);
  var count = 0;
  // Records refused by the express-id bound, reported back to the caller.
  var oversizedIds = 0;

  // Type name cache (IFC files have ~776 unique types across millions of entities)
  var typeCache = new Map();

  function growArrays() {
    var newSize = (count * 2) | 0;
    var newIds = new Uint32Array(newSize);
    newIds.set(ids);
    ids = newIds;
    var newOffsets = new Uint32Array(newSize);
    newOffsets.set(offsets);
    offsets = newOffsets;
    var newLengths = new Uint32Array(newSize);
    newLengths.set(lengths);
    lengths = newLengths;
    var newLines = new Uint32Array(newSize);
    newLines.set(lines);
    lines = newLines;
    types.length = newSize;
  }

  while (pos < len) {
    var ch = buf[pos];

    if (ch === 0x23) { // '#'
      var startOffset = pos;
      var startLine = line;
      pos++;

      // Read express ID
      var expressId = 0;
      var hasDigits = false;
      while (pos < len) {
        var c = buf[pos];
        if (c >= 0x30 && c <= 0x39) {
          expressId = expressId * 10 + (c - 0x30);
          hasDigits = true;
          pos++;
        } else {
          break;
        }
      }
      if (!hasDigits) continue;

      // Whitespace AND comments: '#1 /* was #7 */ =' is a declaration. The
      // inline loop stays for the common case; skipTriviaAt runs only once a
      // comment actually opens. Mirrors tokenizer.ts's scanEntitiesFast.
      while (pos < len) {
        var c2 = buf[pos];
        if (c2 === 0x20 || c2 === 0x09 || c2 === 0x0D) { pos++; }
        else if (c2 === 0x0A) { line++; pos++; }
        else break;
      }
      if (opensCommentAt(pos)) { pos = skipTriviaAt(pos); if (pos < 0) break; }

      // Check for '='
      if (pos >= len || buf[pos] !== 0x3D) continue;
      pos++;

      // Express-id bound, identical to StepTokenizer.scanEntitiesFast -- this
      // worker is that scan's twin and must reject the same records, and count
      // the same ones, or which scan path ran decides both whether an id
      // collides with another and what the user is told was dropped. The
      // single '>' subsumes a safe-integer check: a digit run accumulated as a
      // double is non-negative and integral, and every value past 2^32 --
      // including one past 2^53, where two distinct ids collide onto one
      // double -- fails it. Tested only after '=' has matched, because that is
      // the DECLARATION shape Rust's EntityScanner validates before refusing:
      // the 'continue' below resumes inside the refused record's argument
      // list, so an oversized '#ref' in there arrives here too and would be
      // counted as a second dropped record. Count the refusal; a record that
      // vanishes without a trace is the same defect wearing a different hat.
      if (expressId > ${MAX_EXPRESS_ID}) { oversizedIds++; continue; }

      // Skip whitespace and comments
      while (pos < len) {
        var c3 = buf[pos];
        if (c3 === 0x20 || c3 === 0x09 || c3 === 0x0D) { pos++; }
        else if (c3 === 0x0A) { line++; pos++; }
        else break;
      }
      if (opensCommentAt(pos)) { pos = skipTriviaAt(pos); if (pos < 0) break; }

      // Read type name
      var typeStart = pos;
      if (pos >= len || buf[pos] < 0x41 || buf[pos] > 0x5A) continue;

      while (pos < len) {
        var c4 = buf[pos];
        if ((c4 >= 0x41 && c4 <= 0x5A) || (c4 >= 0x61 && c4 <= 0x7A) ||
            (c4 >= 0x30 && c4 <= 0x39) || c4 === 0x5F) {
          pos++;
        } else {
          break;
        }
      }
      if (pos === typeStart) continue;

      // Cache type name — use length + hash compound key and verify the actual
      // bytes on a hit. Length alone can't disambiguate a 32-bit hash collision
      // (e.g. "Aa"/"BB"), so without the byte compare a crafted/unlucky file
      // could have one type silently misread as another. Mirrors tokenizer.ts.
      var typeLen = pos - typeStart;
      var typeHash = typeLen;
      for (var i = typeStart; i < pos; i++) {
        typeHash = (typeHash * 31 + buf[i]) | 0;
      }
      var cacheKey = typeLen + ':' + typeHash;
      var typeName = typeCache.get(cacheKey);
      var cacheHitMatches = false;
      if (typeName !== undefined && typeName.length === typeLen) {
        cacheHitMatches = true;
        for (var v = 0; v < typeLen; v++) {
          if (typeName.charCodeAt(v) !== buf[typeStart + v]) {
            cacheHitMatches = false;
            break;
          }
        }
      }
      if (typeName === undefined || !cacheHitMatches) {
        typeName = String.fromCharCode.apply(null, buf.subarray(typeStart, pos));
        typeCache.set(cacheKey, typeName);
      }

      // Skip whitespace and comments
      while (pos < len) {
        var c5 = buf[pos];
        if (c5 === 0x20 || c5 === 0x09 || c5 === 0x0D) { pos++; }
        else if (c5 === 0x0A) { line++; pos++; }
        else break;
      }
      if (opensCommentAt(pos)) { pos = skipTriviaAt(pos); if (pos < 0) break; }

      // Check for '('
      if (pos >= len || buf[pos] !== 0x28) continue;

      // Skip to semicolon (handling strings)
      var inString = false;
      while (pos < len) {
        var c6 = buf[pos];
        if (c6 === 0x27) { // quote
          if (inString && pos + 1 < len && buf[pos + 1] === 0x27) {
            pos += 2;
            continue;
          }
          inString = !inString;
        } else if (c6 === 0x2F && !inString && opensCommentAt(pos)) {
          // The ';' that ends a record can be preceded by a comment holding
          // its own ';'. Take the comment whole, which also makes the quotes
          // and parens inside it text -- the other direction of the rule the
          // quote branch above gives for a '/*' inside a literal.
          var ce = skipCommentAt(pos);
          if (ce < 0) {
            // Unterminated: this record has no terminator, and neither has
            // anything after it. Drop it and stop.
            pos = len;
            break;
          }
          pos = ce;
          continue;
        } else if (c6 === 0x3B && !inString) { // semicolon
          var entityLength = pos - startOffset + 1;

          // Grow if needed
          if (count >= ids.length) growArrays();

          ids[count] = expressId;
          offsets[count] = startOffset;
          lengths[count] = entityLength;
          lines[count] = startLine;
          types[count] = typeName;
          count++;

          pos++;
          break;
        } else if (c6 === 0x0A) {
          line++;
        }
        pos++;
      }
    } else if (ch === 0x0A) {
      line++;
      pos++;
    } else if (ch === 0x27) { // quote
      // Consume a string literal whole. HEADER records carry no '#', so this
      // loop walks them byte by byte, and a '/*' inside a description would
      // otherwise open a comment that never closes and take DATA with it.
      var sp = pos + 1;
      while (sp < len) {
        if (buf[sp] === 0x27) {
          if (sp + 1 < len && buf[sp + 1] === 0x27) { sp += 2; continue; }
          sp++;
          break;
        }
        if (buf[sp] === 0x0A) { line++; }
        sp++;
      }
      pos = sp;
    } else if (opensCommentAt(pos)) {
      // Skip a comment region BETWEEN records. A record that is commented out
      // is still a well-formed #id = TYPE(...), so every check above accepts
      // it and only skipping the region rejects it.
      var cp = skipCommentAt(pos);
      if (cp < 0) {
        // Unterminated: everything to EOF is commented out.
        pos = len;
        break;
      }
      pos = cp;
    } else {
      pos++;
    }
  }

  // Trim arrays once, reuse for both message and transfer list
  var needsTrim = ids.buffer.byteLength > count * 4;
  var trimmedIds = needsTrim ? ids.slice(0, count) : ids;
  var trimmedOffsets = needsTrim ? offsets.slice(0, count) : offsets;
  var trimmedLengths = needsTrim ? lengths.slice(0, count) : lengths;
  var trimmedLines = needsTrim ? lines.slice(0, count) : lines;
  self.postMessage({
    ids: trimmedIds.buffer,
    offsets: trimmedOffsets.buffer,
    lengths: trimmedLengths.buffer,
    lines: trimmedLines.buffer,
    types: types.slice(0, count),
    count: count,
    oversizedIds: oversizedIds,
  }, [
    trimmedIds.buffer,
    trimmedOffsets.buffer,
    trimmedLengths.buffer,
    trimmedLines.buffer,
  ]);
};
`;
