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
 * Wrong codes count against a small budget. Exhausting it retires the code
 * and issues a new one, so guessing restarts against fresh entropy, and the
 * new code is reported again (stderr and `bridge_status`).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizePairingCode } from './protocol.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 20;

/** Default wrong attempts allowed against one code before it is retired. */
export const DEFAULT_MAX_PAIRING_ATTEMPTS = 5;

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
  private wrongAttempts = 0;

  constructor(
    private readonly maxAttempts = DEFAULT_MAX_PAIRING_ATTEMPTS,
    private readonly onRegenerated: (code: string) => void = () => {},
  ) {}

  /** The live code, minting one if none is live. */
  current(): string {
    if (this.code === null) this.mint();
    return this.code!;
  }

  /** Retire the live code (if any) and mint a fresh one. */
  rotate(): string {
    this.mint();
    return this.code!;
  }

  /**
   * Check a presented code in constant time. `ok` consumes the code. `wrong`
   * counts an attempt; the last allowed attempt retires the code and mints a
   * new one.
   */
  consume(presented: string): PairingCheck {
    if (this.codeDigest === null) return 'no-code';
    // Compare fixed-length digests so neither length nor content leaks timing.
    if (timingSafeEqual(digest(presented), this.codeDigest)) {
      this.code = null;
      this.codeDigest = null;
      this.wrongAttempts = 0;
      return 'ok';
    }
    this.wrongAttempts++;
    if (this.wrongAttempts >= this.maxAttempts) {
      this.mint();
      this.onRegenerated(this.code!);
    }
    return 'wrong';
  }

  private mint(): void {
    this.code = generatePairingCode();
    this.codeDigest = digest(this.code);
    this.wrongAttempts = 0;
  }
}
