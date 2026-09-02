/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP tokenizer - fast byte-level scanning for entity markers
 * Leverages Spike 1 approach: ~1,259 MB/s throughput
 */

import { isIndexableExpressId } from './express-id.js';
import { BalancedEntityScan, type ScannedEntityRef } from './scan-entities-balanced.js';
import {
  countNewlines,
  opensComment,
  opensLiteralOrComment,
  skipComment,
  skipLexical,
  skipTrivia,
} from './step-lexing.js';

export class StepTokenizer {
  private buffer: Uint8Array;
  private oversizedIds: number = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  /** Records the last scan refused for an out-of-contract express id
   *  (express-id.ts, #3395). Reset per scan; the caller reports it. */
  get oversizedIdCount(): number {
    return this.oversizedIds;
  }

  /**
   * Scan for all entity declarations (#EXPRESS_ID = TYPE(...))
   * Returns entity references without parsing full content.
   *
   * Closes each record on the ')' balancing its argument list. The scan itself
   * lives in `scan-entities-balanced.ts`; only the refusal count comes back
   * here, and it comes back in a `finally` so an abandoned generator still
   * reports what it refused.
   */
  *scanEntities(): Generator<ScannedEntityRef> {
    const scan = new BalancedEntityScan(this.buffer);
    this.oversizedIds = 0;
    try {
      yield* scan.run();
    } finally {
      this.oversizedIds = scan.oversizedIdCount;
    }
  }

  /**
   * FAST scan - skips to semicolon instead of matching parentheses
   * ~5-10x faster for large files, yields length=0 (calculate on-demand)
   */
  *scanEntitiesFast(): Generator<ScannedEntityRef> {
    this.oversizedIds = 0;

    // Pre-compute common byte codes
    const HASH = 0x23;      // '#'
    const EQUALS = 0x3D;    // '='
    const LPAREN = 0x28;    // '('
    const SEMICOLON = 0x3B; // ';'
    const QUOTE = 0x27;     // '\''
    const NEWLINE = 0x0A;   // '\n'
    const SLASH = 0x2F;     // '/'

    const buf = this.buffer;
    const len = buf.length;
    let pos = 0;
    let line = 1;

    // Cache type name strings: IFC files have ~776 unique types repeated
    // across 8M+ entities. Caching avoids millions of String.fromCharCode allocations.
    const typeCache = new Map<string, string>();

    while (pos < len) {
      const char = buf[pos];

      if (char === HASH) {
        const startOffset = pos;
        const startLine = line;
        pos++; // Skip '#'

        // Read express ID (inline for speed)
        let expressId = 0;
        let hasDigits = false;
        while (pos < len) {
          const c = buf[pos];
          if (c >= 0x30 && c <= 0x39) { // '0'-'9'
            expressId = expressId * 10 + (c - 0x30);
            hasDigits = true;
            pos++;
          } else {
            break;
          }
        }

        if (!hasDigits) continue;

        // Skip whitespace (inline)
        while (pos < len) {
          const c = buf[pos];
          if (c === 0x20 || c === 0x09 || c === 0x0D) { pos++; }
          else if (c === NEWLINE) { line++; pos++; }
          else break;
        }

        // 10303-21 allows a comment wherever whitespace is allowed, so
        // `#1 /* was #7 */ =` is a declaration. The inline loop above stays
        // for the common case; this runs only once a comment actually opens,
        // and skipTrivia (step-lexing) then takes the whole run of both.
        if (opensComment(buf, pos, len)) {
          const t = skipTrivia(buf, pos, len);
          line += t.lines;
          pos = t.next;
          if (t.stop) return;
        }

        // Check for '='
        if (pos >= len || buf[pos] !== EQUALS) continue;
        pos++;

        // Storage contract, not just overflow: see express-id.ts (#3395).
        // Tested only now that `#<digits>[ws]*=` has matched, which is the
        // DECLARATION shape Rust's `EntityScanner` validates before it
        // refuses. Refusing above the '=' check counted references too: the
        // `continue` resumes inside the refused record's argument list
        // (unlike the accepted path, which skips to the terminating ';'), so
        // `#4294967297=IFCWALL(#4294967298,#4294967299,...)` reported three
        // skipped records for the one record actually dropped. A count that
        // overstates is the same class of defect as one that undercounts.
        if (!isIndexableExpressId(expressId)) { this.oversizedIds++; continue; }

        // Skip whitespace
        while (pos < len) {
          const c = buf[pos];
          if (c === 0x20 || c === 0x09 || c === 0x0D) { pos++; }
          else if (c === NEWLINE) { line++; pos++; }
          else break;
        }

        if (opensComment(buf, pos, len)) {
          const t = skipTrivia(buf, pos, len);
          line += t.lines;
          pos = t.next;
          if (t.stop) return;
        }

        // Read type name (inline)
        const typeStart = pos;
        if (pos >= len || buf[pos] < 0x41 || buf[pos] > 0x5A) continue; // Must start A-Z

        while (pos < len) {
          const c = buf[pos];
          if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) ||
              (c >= 0x30 && c <= 0x39) || c === 0x5F) {
            pos++;
          } else {
            break;
          }
        }

        if (pos === typeStart) continue;

        // Decode type name with caching — IFC files repeat ~776 types across 8M+ entities.
        // Hash the bytes to avoid 8M+ String.fromCharCode allocations (only ~776 created).
        // Use a length+hash compound key and verify the decoded bytes on hit so a 32-bit
        // hash collision can't silently alias two distinct type names (a malformed/hostile
        // file could otherwise craft a collision and have one type misread as another).
        const typeLen = pos - typeStart;
        let typeHash = typeLen;
        for (let i = typeStart; i < pos; i++) {
          typeHash = (typeHash * 31 + buf[i]) | 0;
        }
        const cacheKey = `${typeLen}:${typeHash}`;
        let type = typeCache.get(cacheKey);
        let cacheHitMatches = false;
        if (type !== undefined && type.length === typeLen) {
          cacheHitMatches = true;
          for (let i = 0; i < typeLen; i++) {
            if (type.charCodeAt(i) !== buf[typeStart + i]) {
              cacheHitMatches = false;
              break;
            }
          }
        }
        // `type === undefined` is implied by !cacheHitMatches, but naming it
        // here lets TS narrow `type` to `string` on the fall-through path.
        if (type === undefined || !cacheHitMatches) {
          type = String.fromCharCode(...buf.subarray(typeStart, pos));
          typeCache.set(cacheKey, type);
        }

        // Skip whitespace
        while (pos < len) {
          const c = buf[pos];
          if (c === 0x20 || c === 0x09 || c === 0x0D) { pos++; }
          else if (c === NEWLINE) { line++; pos++; }
          else break;
        }

        if (opensComment(buf, pos, len)) {
          const t = skipTrivia(buf, pos, len);
          line += t.lines;
          pos = t.next;
          if (t.stop) return;
        }

        // Check for '('
        if (pos >= len || buf[pos] !== LPAREN) continue;

        // FAST: Skip to semicolon (handling strings)
        let inString = false;
        while (pos < len) {
          const c = buf[pos];
          if (c === QUOTE) {
            if (inString && pos + 1 < len && buf[pos + 1] === QUOTE) {
              pos += 2; // Skip escaped quote
              continue;
            }
            inString = !inString;
          } else if (c === SLASH && !inString && opensComment(buf, pos, len)) {
            // The ';' that ends a record can be preceded by a comment holding
            // its own ';'. Take the comment whole -- which also makes the
            // quotes and parens inside it text, the other half of the rule the
            // literal skip above provides in the opposite direction.
            const end = skipComment(buf, pos, len);
            if (end < 0) {
              // Unterminated: this record has no terminator, and neither has
              // anything after it. Drop it and stop, which is the None Rust's
              // find_entity_end returns on the same input.
              return;
            }
            line += countNewlines(buf, pos, end);
            pos = end;
            continue;
          } else if (c === SEMICOLON && !inString) {
            // Found end of entity
            const entityLength = pos - startOffset + 1; // Include semicolon
            yield { expressId, type, offset: startOffset, length: entityLength, line: startLine };
            pos++;
            break;
          } else if (c === NEWLINE) {
            line++;
          }
          pos++;
        }
      } else if (char === NEWLINE) {
        line++;
        pos++;
      } else if (opensLiteralOrComment(buf, pos, len)) {
        // After the newline branch, not before it: the inner loop consumes
        // entity bodies, so newline is the commonest byte this chain sees.
        // The byte values are mutually exclusive, so order is
        // semantics-neutral. See step-lexing for what is skipped and why.
        const skip = skipLexical(buf, pos, len);
        line += skip.lines;
        pos = skip.next;
        if (skip.stop) return;
      } else {
        pos++;
      }
    }

  }
}
