/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Translate an XSD regex pattern into JavaScript regex syntax.
 *
 * Ported from `IdsLib/IdsSchema/XsNodes/XmlRegex.cs` (MIT) which itself
 * mirrors Microsoft's reference XSD facet checker. XSD regex extends
 * the JS dialect with:
 *
 *  - `\i`  — XML name start char (letter, `_`, `:` plus a swathe of
 *            Unicode letters)
 *  - `\c`  — XML name char (`\i` plus digits, `.`, `-`, U+00B7, etc.)
 *  - `\d`  — Unicode digit (broader than JS `[0-9]`)
 *  - `\w`  — Unicode word char (letters + digits, no `_`)
 *  - `\D`, `\C`, `\I`, `\W` — negations
 *  - char-class subtraction `[a-z-[aeiou]]` — the JS dialect doesn't
 *    support this; we fall back to a marker so the auditor can warn.
 *
 * The translation maps to JS Unicode property escapes (require `u` flag).
 * `\d` and `\w` already exist in JS and map close enough that we leave
 * them alone — same applies to `\D`/`\W`. The XML name char escapes are
 * the only ones that genuinely need translation.
 */

interface TranslateResult {
  /** The pattern usable with the JS `RegExp` constructor. */
  pattern: string;
  /** Whether translation produced a faithful JS-compatible regex. */
  supported: boolean;
  /**
   * Human-readable reason when `supported === false`. Empty string when
   * fully supported.
   */
  reason: string;
}

/**
 * Translate the XSD pattern. Returns the JS-compatible pattern plus a
 * `supported` flag — when `false`, the auditor should warn rather than
 * compile-test the result (the unsupported construct may produce
 * spurious failures).
 */
export function translateXsdRegex(pattern: string): TranslateResult {
  // Char-class subtraction is only safely expressible via lookarounds in
  // simple cases; in general it requires set algebra. Surface it as
  // unsupported so the auditor warns.
  if (/\[[^\]]*-\[/.test(pattern)) {
    return {
      pattern,
      supported: false,
      reason: 'XSD character-class subtraction is not supported in JS regex',
    };
  }

  let translated = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern.charAt(i + 1);
      const replacement = mapEscape(next);
      if (replacement) {
        translated += replacement;
        i += 2;
        continue;
      }
      // Pass through any other escape (`\n`, `\.`, `\\`, …).
      translated += ch + next;
      i += 2;
      continue;
    }
    translated += ch;
    i++;
  }
  return { pattern: translated, supported: true, reason: '' };
}

/**
 * Map an XSD-specific escape character to its JS regex Unicode-property
 * equivalent. Returns `undefined` when the escape is identical in both
 * dialects (and thus needs no translation).
 *
 * The XML production rules these escape codes implement live in the
 * W3C XML 1.0 spec § 2.3 (NameStartChar / NameChar) and § 2.5 (Digit /
 * Letter). We use JS Unicode property escapes (`\p{L}`, `\p{Nd}`) which
 * are equivalent for our purposes when the pattern is compiled with the
 * `u` flag.
 */
function mapEscape(ch: string): string | undefined {
  switch (ch) {
    case 'i':
      // NameStartChar: letters + `_` + `:` + extended Unicode letters.
      return '[\\p{L}_:]';
    case 'I':
      return '[^\\p{L}_:]';
    case 'c':
      // NameChar: NameStartChar + digits + `.` + `-` + U+00B7 + combining marks.
      return '[\\p{L}\\p{Nd}_:.\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040]';
    case 'C':
      return '[^\\p{L}\\p{Nd}_:.\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040]';
    case 'd':
      // JS \d matches `[0-9]`; XSD \d matches all Unicode digits. Use
      // \p{Nd} for full fidelity.
      return '\\p{Nd}';
    case 'D':
      return '\\P{Nd}';
    case 'w':
      // JS \w matches `[A-Za-z0-9_]`; XSD \w matches Unicode letters +
      // digits without underscore. Use a Unicode class that mirrors the
      // XSD definition.
      return '[\\p{L}\\p{Nd}]';
    case 'W':
      return '[^\\p{L}\\p{Nd}]';
    default:
      return undefined;
  }
}

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
