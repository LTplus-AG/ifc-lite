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

  constructor(private readonly buffer: Uint8Array) {}

  /** Records this scan refused for an out-of-contract express id (#3395). */
  get oversizedIdCount(): number {
    return this.oversizedIds;
  }

  /** Every entity declaration (`#EXPRESS_ID = TYPE(...)`) in the buffer. */
  *run(): Generator<ScannedEntityRef> {
    this.position = 0;
    this.lineNumber = 1;
    this.oversizedIds = 0;

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

        // Whitespace AND comments: 10303-21 allows a comment wherever
        // whitespace is allowed, so `#1 /* was #7 */ =` is a declaration.
        this.skipTrivia();

        // Check for '=' (assignment)
        if (this.position >= this.buffer.length || this.buffer[this.position] !== 0x3D) {
          this.position++;
          continue;
        }
        this.position++; // Skip '='

        this.skipTrivia();

        // Read type name
        const type = this.readTypeName();
        if (!type) {
          this.position++;
          continue;
        }

        this.skipTrivia();

        // Check for '(' (start of parameters)
        if (this.position >= this.buffer.length || this.buffer[this.position] !== 0x28) {
          this.position++;
          continue;
        }

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
        if (skip.stop) return;
      } else {
        this.position++;
      }
    }
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
   *
   * An unterminated comment leaves `position` at end of buffer, so the check
   * that follows every call site fails and the scan runs out -- which is what
   * "everything after this point is inside a comment" should look like.
   */
  private skipTrivia(): void {
    const skip = skipTrivia(this.buffer, this.position, this.buffer.length);
    this.lineNumber += skip.lines;
    this.position = skip.next;
  }
}
