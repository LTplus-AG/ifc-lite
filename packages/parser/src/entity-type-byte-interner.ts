/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const MAX_COLLISION_BUCKET = 8;
const MAX_FAST_BUCKETS = 4096;

type Bucket = string[] | Map<string, string>;

/** Scan-scoped byte interning (#3985). A hash selects candidates, never identity.
 * Repeated normal tokens allocate no string; adversarial collisions switch to
 * native string-key lookup after a bounded number of byte comparisons.
 */
export class EntityTypeByteInterner {
  private readonly buckets = new Map<number, Bucket>();
  private readonly overflow = new Map<string, string>();

  intern(bytes: Uint8Array, start: number, end: number, hash: number): string {
    const bucket = this.buckets.get(hash);
    if (bucket instanceof Map) return this.internString(bucket, bytes, start, end);
    if (bucket) {
      const length = end - start;
      for (const candidate of bucket) {
        if (candidate.length !== length) continue;
        let i = 0;
        while (i < length) {
          const byte = bytes[start + i];
          const upper = byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte;
          if (candidate.charCodeAt(i) !== upper) break;
          i++;
        }
        if (i === length) return candidate;
      }
      const value = this.readString(bytes, start, end);
      if (bucket.length < MAX_COLLISION_BUCKET) bucket.push(value);
      else {
        const strings = new Map<string, string>();
        for (const candidate of bucket) strings.set(candidate, candidate);
        strings.set(value, value);
        this.buckets.set(hash, strings);
      }
      return value;
    }
    // A source containing millions of different type spellings must not gain
    // an extra array/map per spelling compared with the original interner.
    if (this.buckets.size >= MAX_FAST_BUCKETS) {
      return this.internString(this.overflow, bytes, start, end);
    }
    const value = this.readString(bytes, start, end);
    this.buckets.set(hash, [value]);
    return value;
  }

  private internString(strings: Map<string, string>, bytes: Uint8Array, start: number, end: number): string {
    const value = this.readString(bytes, start, end);
    const previous = strings.get(value);
    if (previous !== undefined) return previous;
    strings.set(value, value);
    return value;
  }

  private readString(bytes: Uint8Array, start: number, end: number): string {
    // Entity keywords are case-insensitive. Canonicalize the pre-scanned path
    // at its raw boundary, like the tokenizer and worker scanners, so public
    // EntityRef values and compact byType keys never depend on the load path.
    // Fold ASCII only: STEP keywords are ASCII, while an invalid high byte is
    // retained rather than being expanded by Unicode case conversion.
    let value = '';
    for (let i = start; i < end; i++) {
      const byte = bytes[i];
      value += String.fromCharCode(byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte);
    }
    return value;
  }
}
