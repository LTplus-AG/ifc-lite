/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP tokenizer - fast byte-level scanning for entity markers
 * Leverages Spike 1 approach: ~1,259 MB/s throughput
 */

import { safeUtf8Decode } from '@ifc-lite/data';

export class StepTokenizer {
  private buffer: Uint8Array;
  private position: number = 0;
  private lineNumber: number = 1;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  /**
   * Scan for all entity declarations (#EXPRESS_ID = TYPE(...))
   * Returns entity references without parsing full content
   */
  *scanEntities(): Generator<{ expressId: number; type: string; offset: number; length: number; line: number }> {
    this.position = 0;
    this.lineNumber = 1;

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

        // Skip whitespace
        this.skipWhitespace();

        // Check for '=' (assignment)
        if (this.position >= this.buffer.length || this.buffer[this.position] !== 0x3D) {
          this.position++;
          continue;
        }
        this.position++; // Skip '='

        // Skip whitespace
        this.skipWhitespace();

        // Read type name
        const type = this.readTypeName();
        if (!type) {
          this.position++;
          continue;
        }

        // Skip whitespace
        this.skipWhitespace();

        // Check for '(' (start of parameters)
        if (this.position >= this.buffer.length || this.buffer[this.position] !== 0x28) {
          this.position++;
          continue;
        }

        // Find matching closing parenthesis to get full entity length
        const entityLength = this.findEntityLength(startOffset);
        if (entityLength > 0) {
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
      } else {
        this.position++;
      }
    }
  }

  /**
   * FAST scan - skips to semicolon instead of matching parentheses
   * ~5-10x faster for large files, yields length=0 (calculate on-demand)
   */
  *scanEntitiesFast(): Generator<{ expressId: number; type: string; offset: number; length: number; line: number }> {
    this.position = 0;
    this.lineNumber = 1;

    // Pre-compute common byte codes
    const HASH = 0x23;      // '#'
    const EQUALS = 0x3D;    // '='
    const LPAREN = 0x28;    // '('
    const SEMICOLON = 0x3B; // ';'
    const QUOTE = 0x27;     // '\''
    const NEWLINE = 0x0A;   // '\n'

    const buf = this.buffer;
    const len = buf.length;
    let pos = 0;
    let line = 1;

    // Cache type name strings: IFC files have ~776 unique types repeated
    // across 8M+ entities. Caching avoids millions of String.fromCharCode allocations.
    const typeCache = new Map<number, string>();

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

        // Check for '='
        if (pos >= len || buf[pos] !== EQUALS) continue;
        pos++;

        // Skip whitespace
        while (pos < len) {
          const c = buf[pos];
          if (c === 0x20 || c === 0x09 || c === 0x0D) { pos++; }
          else if (c === NEWLINE) { line++; pos++; }
          else break;
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
        let typeHash = pos - typeStart;
        for (let i = typeStart; i < pos; i++) {
          typeHash = (typeHash * 31 + buf[i]) | 0;
        }
        let type = typeCache.get(typeHash);
        if (type === undefined) {
          type = String.fromCharCode(...buf.subarray(typeStart, pos));
          typeCache.set(typeHash, type);
        }

        // Skip whitespace
        while (pos < len) {
          const c = buf[pos];
          if (c === 0x20 || c === 0x09 || c === 0x0D) { pos++; }
          else if (c === NEWLINE) { line++; pos++; }
          else break;
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
      } else {
        pos++;
      }
    }

    this.position = pos;
    this.lineNumber = line;
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
    this.position = pos;
    return id;
  }

  private readTypeName(): string | null {
    let start = this.position;
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

  private skipWhitespace(): void {
    while (this.position < this.buffer.length) {
      const char = this.buffer[this.position];
      if (char === 0x20 || char === 0x09 || char === 0x0D || char === 0x0A) { // space, tab, CR, LF
        if (char === 0x0A) this.lineNumber++;
        this.position++;
      } else {
        break;
      }
    }
  }

  private findEntityLength(startOffset: number): number {
    let pos = this.position;
    let depth = 0;
    let inString = false;

    while (pos < this.buffer.length) {
      const char = this.buffer[pos];

      if (char === 0x27) { // Single quote (string delimiter)
        if (inString) {
          // Check for escaped quote ('') - STEP uses doubled quotes
          if (pos + 1 < this.buffer.length && this.buffer[pos + 1] === 0x27) {
            pos += 2; // Skip escaped quote
            continue;
          }
          inString = false;
        } else {
          inString = true;
        }
        pos++;
        continue;
      }

      if (inString) {
        pos++;
        continue;
      }

      if (char === 0x28) { // '('
        depth++;
        pos++;
      } else if (char === 0x29) { // ')'
        depth--;
        pos++;
        if (depth === 0) {
          // Found matching closing parenthesis
          return pos - startOffset;
        }
      } else {
        pos++;
      }
    }

    return 0; // No matching closing parenthesis found
  }
}
