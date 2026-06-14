/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Auditor-facing XSD-regex helpers. The translation itself now lives in
 * the shared `constraints/xsd-regex` module so the auditor and the
 * constraint matcher (`matchPattern`) can't drift apart; this file keeps
 * the auditor-specific `compileXsdRegex` wrapper and re-exports the
 * translator for existing call sites.
 */

import {
  translateXsdRegex,
  type TranslateResult,
} from '../../constraints/xsd-regex.js';

export { translateXsdRegex, type TranslateResult };

/**
 * Try to compile `pattern` as XSD regex semantics. Returns:
 *  - `{ ok: true }` when the pattern is valid (after translation).
 *  - `{ ok: false, severity: 'error', reason }` for syntactic errors
 *    that JS *and* XSD agree on (e.g. unclosed `[`).
 *  - `{ ok: false, severity: 'warning', reason }` when the pattern uses
 *    XSD-only syntax we can't translate (char-class subtraction).
 */
export function compileXsdRegex(
  pattern: string
):
  | { ok: true; jsPattern: string }
  | { ok: false; severity: 'error' | 'warning'; reason: string } {
  if (pattern === '') {
    return { ok: false, severity: 'error', reason: 'pattern is empty' };
  }
  const translated = translateXsdRegex(pattern);
  if (!translated.supported) {
    return { ok: false, severity: 'warning', reason: translated.reason };
  }
  try {
    new RegExp(translated.pattern, 'u');
    return { ok: true, jsPattern: translated.pattern };
  } catch (err) {
    return {
      ok: false,
      severity: 'error',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
