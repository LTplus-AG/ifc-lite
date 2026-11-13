/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One-time pairing codes for `--bridge` (#9523).
 *
 * A code is 20 characters of Crockford base32 (100 bits), shown in groups of
 * five. It is consumed by the first successful pairing and never accepted
 * again. A fresh code exists only when one is asked for: at start, through
 * `bridge_status`, or after the paired tab goes away. While a tab is paired
 * there is no live code, so nothing can take its place unless the user asks.
 *
 * Wrong codes never retire the code: a peer guessing must not be able to
 * invalidate the link the user was given. Guessing is slowed instead by
 * `PairingGate` (rate-limits.ts): at most 4 comparisons per 5 s during an
 * attack, so 100 bits are out of reach.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizePairingCode } from './pairing-link.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 20;

export function generatePairingCode(): string {
  const bytes = randomBytes(CODE_CHARS);
  let out = '';
  // 256 is a multiple of 32, so `b % 32` is unbiased.
  for (let i = 0; i < CODE_CHARS; i++) out += ALPHABET[bytes[i] % 32];
  return out.match(/.{5}/g)!.join('-');
}

function digest(code: string): Buffer {
  return createHash('sha256').update(normalizePairingCode(code), 'utf8').digest();
}

export type PairingCheck = 'ok' | 'wrong' | 'no-code';

export class PairingCodes {
  private code: string | null = null;
  private codeDigest: Buffer | null = null;

  /** The live code, minting one if none is live. */
  current(): string {
    if (this.code === null) this.mint();
    return this.code!;
  }

  /** True when a code is live (none is while a tab is paired, until one is asked for). */
  live(): boolean {
    return this.code !== null;
  }

  /** Retire the live code (if any) and mint a fresh one. */
  rotate(): string {
    this.mint();
    return this.code!;
  }

  /** Check a presented code in constant time. `ok` consumes the code; `wrong` leaves it live. */
  consume(presented: string): PairingCheck {
    if (this.codeDigest === null) return 'no-code';
    // Compare fixed-length digests so neither length nor content leaks timing.
    if (timingSafeEqual(digest(presented), this.codeDigest)) {
      this.code = null;
      this.codeDigest = null;
      return 'ok';
    }
    return 'wrong';
  }

  private mint(): void {
    this.code = generatePairingCode();
    this.codeDigest = digest(this.code);
  }
}
