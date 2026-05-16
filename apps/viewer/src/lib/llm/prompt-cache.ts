/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Prompt-cache shaping helpers shared by `stream-direct.ts` (BYOK
 * Anthropic SDK path) and `stream-client.ts` (proxy path).
 *
 * Anthropic supports a `cache_control: { type: 'ephemeral' }` marker
 * on system-prompt blocks that pins the prefix into a 5-minute server
 * cache. Subsequent calls with the same prefix hit the cache and pay
 * a 10% read cost instead of the full input price.
 *
 * Threshold: 4096 chars (~1024 tokens at 4 chars/token) — Anthropic's
 * documented minimum cacheable size. Below the threshold the wrapper
 * returns the raw string, so cheap one-shot turns don't get the array
 * shape.
 *
 * The contract: callers send the result as `system` in the
 * Messages.create payload. The Anthropic SDK and the proxy both
 * accept both `string` and the array form, so this is safe on both
 * paths.
 *
 * Observability: when caching kicks in we log to console under
 * `[ext:prompt-cache]`. The Anthropic response carries usage fields
 * `cache_creation_input_tokens` and `cache_read_input_tokens` —
 * stream callers that surface these via `onUsageInfo` get the hit
 * rate visible in dev tools.
 */

const CACHE_THRESHOLD_CHARS = 4096;

export interface CacheableTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/**
 * Build the `system` argument for an Anthropic call. Returns:
 *   - `undefined` when the input is empty
 *   - the raw string when below threshold
 *   - a single-element array with `cache_control: { type: 'ephemeral' }`
 *     when the prompt is long enough to be worth caching
 */
export function buildCacheableSystem(
  system: string | undefined,
): string | CacheableTextBlock[] | undefined {
  if (!system) return undefined;
  if (system.length < CACHE_THRESHOLD_CHARS) return system;
  if (typeof console !== 'undefined' && console.debug) {
    console.debug(
      `[ext:prompt-cache] wrapping ${system.length}-char system prompt in ephemeral cache block`,
    );
  }
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

/**
 * Log a cache-hit summary from a usage payload when present. Callers
 * forward this from the stream completion event so we can see the
 * cache_read / cache_creation token split per turn in dev tools.
 */
export function logCacheHit(usage: {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
} | null | undefined): void {
  if (!usage) return;
  const creation = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  if (creation === 0 && read === 0) return;
  if (typeof console !== 'undefined' && console.debug) {
    console.debug(
      `[ext:prompt-cache] cache_read=${read} cache_creation=${creation}`,
    );
  }
}
