/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one reader for runtime perf flags (#6962).
 *
 * Perf toggles were scattered `globalThis.__IFC_LITE_*` reads, each with its
 * own cast. They now go through this tiny reader so the binding (which global,
 * which URL param) is declared once per flag. It lives in this low-level
 * package because `@ifc-lite/geometry` reads three flags on the host thread
 * and must not import the viewer; the viewer's registry
 * (`apps/viewer/src/lib/perf/flags.ts`) declares the full metadata (owner,
 * removal condition, ...) and reads through the same function.
 *
 * `scripts/check-perf-flags.mjs` fails CI on a `__IFC_LITE_*` global read
 * anywhere else in production code.
 */

/** Every perf global shares this prefix; the CI ratchet keys on it. */
export type PerfFlagGlobalName = `__IFC_LITE_${string}`;

/** Where a flag's raw value can come from, in precedence order. */
export interface PerfFlagBinding {
  /** `globalThis` property (console / benchmark injection). Wins when set. */
  readonly global: PerfFlagGlobalName;
  /** Optional URL query param consulted when the global is unset. */
  readonly urlParam?: string;
}

/**
 * Parse a URL query value into the same shapes a global override takes:
 * finite numbers, booleans, or a JSON object/array. Anything else stays a
 * string so the flag's own parser can reject it.
 */
export function parsePerfFlagUrlValue(raw: string): unknown {
  const text = raw.trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text !== '' && Number.isFinite(Number(text))) return Number(text);
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      console.warn('[perf-flags] ignoring malformed JSON URL value:', raw, error);
      return undefined;
    }
  }
  return raw;
}

/** Raw value of a URL query param on the current page, or `null` (also off-browser). */
export function readPerfFlagUrlParam(param: string): string | null {
  const search = (globalThis as { location?: { search?: unknown } }).location?.search;
  if (typeof search !== 'string' || search === '') return null;
  return new URLSearchParams(search).get(param);
}

/**
 * Raw value of a perf flag, or `undefined` when nothing overrides it (the
 * caller applies its default). Precedence: an explicitly set global (not
 * `undefined`/`null`), then the URL param.
 */
export function readPerfFlagRaw(binding: PerfFlagBinding): unknown {
  const value = (globalThis as Record<string, unknown>)[binding.global];
  if (value !== undefined && value !== null) return value;
  if (binding.urlParam) {
    const raw = readPerfFlagUrlParam(binding.urlParam);
    if (raw !== null) return parsePerfFlagUrlValue(raw);
  }
  return value ?? undefined;
}
