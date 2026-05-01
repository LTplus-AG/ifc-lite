/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-peer write budget — open problem #10.
 *
 * AI agents (and over-eager scripts) can outwrite humans 100× in a
 * sustained session. The server gates per-connection writes with a token
 * bucket so a single agent peer can't starve real-time human edits.
 *
 * Default thresholds are generous; production deployments should tune
 * them per role (humans get higher, service accounts lower).
 */

export interface RateLimitOptions {
  /** Capacity of the token bucket — burst size. Default 200. */
  capacity?: number;
  /** Refill rate in tokens per second. Default 60. */
  refillPerSecond?: number;
}

export interface RateLimiter {
  /**
   * Try to consume `n` tokens. Returns true if allowed, false if the
   * bucket is empty.
   */
  tryConsume(n?: number): boolean;
  /** Current available tokens (rounded). */
  available(): number;
  /** Reset the bucket to full. */
  reset(): void;
}

export function createRateLimiter(opts: RateLimitOptions = {}): RateLimiter {
  const capacity = opts.capacity ?? 200;
  const refill = opts.refillPerSecond ?? 60;
  let tokens = capacity;
  let lastRefill = Date.now();

  const top = () => {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    if (elapsed > 0) {
      tokens = Math.min(capacity, tokens + elapsed * refill);
      lastRefill = now;
    }
  };

  return {
    tryConsume(n = 1) {
      top();
      if (tokens >= n) {
        tokens -= n;
        return true;
      }
      return false;
    },
    available() {
      top();
      return Math.floor(tokens);
    },
    reset() {
      tokens = capacity;
      lastRefill = Date.now();
    },
  };
}
