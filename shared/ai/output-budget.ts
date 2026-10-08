/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Validate at both caller and server boundaries; never silently enlarge a budget. */
export function outputTokenLimit(requested: unknown, ceiling: number): number {
  if (requested === undefined) return ceiling;
  if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1) {
    throw new Error('maxOutputTokens must be a positive safe integer');
  }
  return Math.min(requested, ceiling);
}

export const PROXY_OUTPUT_TOKEN_CEILING = 8192;
export const OPENAI_OUTPUT_TOKEN_CEILING = 8192;
export const ANTHROPIC_OUTPUT_TOKEN_CEILING = 32_000;
