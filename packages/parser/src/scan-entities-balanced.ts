/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The balanced-parenthesis entity scan: closes a record on the ')' that
 * balances its argument list, rather than on the terminating ';'.
 *
 * Split out of `tokenizer.ts`, which holds the fast semicolon scan
 * (`StepTokenizer.scanEntitiesFast`). The two share nothing but the
 * `step-lexing` helpers -- the cursor helpers below (`readExpressId`,
 * `readTypeName`, `skipTrivia`) exist only for this scan, because the fast one
 * inlines its equivalents for speed. `StepTokenizer.scanEntities` is the
 * public entry point and delegates here.
 */

import { safeUtf8Decode } from '@ifc-lite/data';

import { isIndexableExpressId } from './express-id.js';
import {
  countNewlines,
  findEntityLength,
  opensLiteralOrComment,
  skipLexical,
  skipTrivia,
} from './step-lexing.js';

export interface ScannedEntityRef {
  expressId: number;
  type: string;
  offset: number;
  length: number;
  line: number;
}

/**
 * One balanced-parenthesis scan over one buffer.
 *
 * The cursor and the refusal count are bound to the scan rather than kept on
 * `StepTokenizer`, so a second scan cannot read the first one's leftovers.
 */
export class BalancedEntityScan {
  private position = 0;
  private lineNumber = 1;
  private oversizedIds = 0;
  private malformed = 0;

  constructor(private readonly buffer: Uint8Array) {}

  /** Records this scan refused for an out-of-contract express id (#3395). */
  get oversizedIdCount(): number {
    return this.oversizedIds;
  }

  /** Mirrors `StepTokenizer.malformedRecordCount`'s contract: 0 or 1, set by
   *  the single post-loop check at the end of `run()`. */
  get malformedRecordCount(): number {
    return this.malformed;
  }

  /** Every entity declaration (`#EXPRESS_ID = TYPE(...)`) in the buffer. */
  *run(): Generator<ScannedEntityRef> {
    this.position = 0;
    this.lineNumber = 1;
    this.oversizedIds = 0;
    this.malformed = 0;

    // Set on the way to the single post-loop check below: `stopped` for an
    // unclosed string or comment that ran the scan to end of buffer with
    // nothing left to find, `declOpen` while a `#id=TYPE(` header is
    // incomplete (cleared once its '(' is found; re-armed by the next '#').
    let stopped = false;
    let declOpen = false;

    while (this.position < this.buffer.length) {
      // Look for '#' character (entity ID marker)
      if (this.buffer[this.position] === 0x23) { // '#'
        const startOffset = this.position;
        const startLine = this.lineNumber;

        // Read express ID
        const expressId = this.readExpressId();
        if (expressId === null) {
          this.position++;
          continue;
        }
        declOpen = true;

        // Whitespace AND comments: 10303-21 allows a comment wherever
        // whitespace is allowed, so `#1 /* was #7 */ =` is a declaration.
        if (this.skipTrivia()) { stopped = true; break; }

        // Check for '=' (assignment)
        if (this.position >= this.buffer.length || this.buffer[this.position] !== 0x3D) {
          this.position++;
          continue;
        }
        this.position++; // Skip '='

        if (this.skipTrivia()) { stopped = true; break; }

        // Read type name
        const type = this.readTypeName();
        if (!type) {
          this.position++;
          continue;
        }

        if (this.skipTrivia()) { stopped = true; break; }

        // Check for '(' (start of parameters)
        if (this.position >= this.buffer.length || this.buffer[this.position] !== 0x28) {
          this.position++;
          continue;
        }
        declOpen = false; // header complete: '(' found

        // Find matching closing parenthesis to get full entity length
        const entityLength = findEntityLength(this.buffer, this.position, startOffset);
        if (entityLength > 0) {
          // Step past the whole record, as Rust's next_entity does. Leaving
          // `position` at the '(' made this loop re-walk the body, which was
          // harmless only while it ignored quotes and comments.
          //
          // Count from `position`, not from `startOffset`: `position` is on the
          // '(' here, and every newline before it was already counted by the
          // three skipTrivia calls above. Counting the whole record instead
          // double-counts a newline written between `#1=` and its type name,
          // which is ordinary whitespace and legal.
          this.lineNumber += countNewlines(
            this.buffer,
            this.position,
            startOffset + entityLength,
          );
          this.position = startOffset + entityLength;
          yield {
            expressId,
            type,
            offset: startOffset,
            length: entityLength,
            line: startLine,
          };
        } else {
          // 0 means findEntityLength ran off the end of the buffer without
          // ever balancing the '(' -- an unterminated literal or comment
          // inside the argument list, or no closing ')' at all. Its own loop
          // has no other exit, so this is always the EOF case, never a
          // mid-file syntax choice to resume past.
          stopped = true;
          break;
        }
      } else if (this.buffer[this.position] === 0x0A) {
        // Newline
        this.lineNumber++;
        this.position++;
      } else if (opensLiteralOrComment(this.buffer, this.position, this.buffer.length)) {
        // A commented-out record satisfies every check above, so a comment has
        // to be skipped as a region; a literal has to be skipped so its
        // contents cannot look like one. See step-lexing.
        const skip = skipLexical(this.buffer, this.position, this.buffer.length);
        this.lineNumber += skip.lines;
        this.position = skip.next;
        if (skip.stop) { stopped = true; break; }
      } else {
        this.position++;
      }
    }

    // ONE post-loop check, not an increment at every exit site above: the
    // scan stopped early if it hit an explicit "no terminator" boundary, or
    // the last `#id=TYPE(` header was cut short before its '(' was found.
    // Always 0 or 1 -- the scan stops at the first one, so there is nothing
    // to accumulate past that.
    if (stopped || declOpen) this.malformed = 1;
  }

  private readExpressId(): number | null {
    let id = 0;
    let digits = 0;
    let pos = this.position + 1; // Skip '#'

    while (pos < this.buffer.length) {
      const char = this.buffer[pos];
      if (char >= 0x30 && char <= 0x39) { // '0'-'9'
        id = id * 10 + (char - 0x30);
        digits++;
        pos++;
      } else {
        break;
      }
    }

    if (digits === 0) return null;
    // Same storage contract as scanEntitiesFast; see express-id.ts (#3395).
    // And the same rule about WHICH refusals count: only a declaration,
    // `#<trivia>=`. This scan resumes one byte into a refused record and
    // walks its argument list, so an oversized `#ref` in there reaches this
    // method too. Look ahead rather than consume — `position` must stay where
    // the caller's recovery expects it.
    if (!isIndexableExpressId(id)) {
      // Trivia, not just whitespace, so this probe recognises exactly the
      // declarations the accept path above does. Skipping only whitespace here
      // would let `#4294967297 /* n */ =` be dropped without being counted.
      const probe = skipTrivia(this.buffer, pos, this.buffer.length).next;
      if (probe < this.buffer.length && this.buffer[probe] === 0x3D) this.oversizedIds++;
      return null;
    }
    this.position = pos;
    return id;
  }

  private readTypeName(): string | null {
    const start = this.position;
    let end = start;

    // Type names start with uppercase letter
    if (this.position >= this.buffer.length || this.buffer[this.position] < 0x41 || this.buffer[this.position] > 0x5A) {
      return null;
    }

    while (end < this.buffer.length) {
      const char = this.buffer[end];
      // Allow letters, numbers, and underscore
      if (
        (char >= 0x41 && char <= 0x5A) || // A-Z
        (char >= 0x61 && char <= 0x7A) || // a-z
        (char >= 0x30 && char <= 0x39) || // 0-9
        char === 0x5F // _
      ) {
        end++;
      } else {
        break;
      }
    }

    if (end === start) return null;

    const typeName = safeUtf8Decode(this.buffer, start, end);
    this.position = end;
    return typeName;
  }

  /**
   * Advance past whitespace and comments (see `skipTrivia` in step-lexing).
   * Returns true when the comment it was in never closed, so the caller's
   * single post-loop check can count it instead of reading a false '0' from
   * a scan that actually ran out of buffer mid-header.
   */
  private skipTrivia(): boolean {
    const skip = skipTrivia(this.buffer, this.position, this.buffer.length);
    this.lineNumber += skip.lines;
    this.position = skip.next;
    return skip.stop;
  }
}
