/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical XSD-regex → JavaScript-regex translator shared by the
 * constraint matcher (`matchPattern`) and the document auditor
 * (`audit/coherence`). Keeping a single implementation avoids the two
 * dialects drifting apart.
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
 *  - `\p{IsBasicLatin}`-style Unicode *block* escapes — .NET supports
 *    these but JS does not, so they are approximated.
 *  - char-class subtraction `[a-z-[aeiou]]` — no JS equivalent.
 *
 * The translation maps to JS Unicode property escapes, so the compiled
 * `RegExp` MUST use the `u` flag. Verbatim `\p{…}` / `\P{…}` *category*
 * classes pass through unchanged — they too require `u`.
 *
 * Translation is character-class aware: a multi-character escape like
 * `\w` expands to a bracketed class `[\p{L}\p{Nd}]` at top level but to
 * its bare members `\p{L}\p{Nd}` when it already sits inside `[ … ]`, so
 * `[\w]` does not become the invalid nested class `[[\p{L}\p{Nd}]]`.
 * Constructs with no faithful JS form (block escapes, a negated class
 * escape inside `[ … ]`) are replaced with an any-character placeholder
 * and `supported` is set to `false` so callers can warn instead of
 * trusting the (approximate) result.
 */

export interface TranslateResult {
  /** The pattern usable with the JS `RegExp` constructor (under `u`). */
  pattern: string;
  /** Whether translation produced a faithful JS-compatible regex. */
  supported: boolean;
  /**
   * Human-readable reason when `supported === false`. Empty string when
   * fully supported.
   */
  reason: string;
}

/** Any single character — placeholder for untranslatable constructs. */
const ANY_OUTSIDE_CLASS = '[\\s\\S]';
const ANY_INSIDE_CLASS = '\\s\\S';

/**
 * Translate the XSD pattern. Returns the JS-compatible pattern plus a
 * `supported` flag — when `false`, callers should warn / treat the
 * result leniently (an untranslatable construct was approximated).
 */
export function translateXsdRegex(pattern: string): TranslateResult {
  let out = '';
  let i = 0;
  let inClass = false;
  let reason = '';
  const flag = (r: string) => {
    if (!reason) reason = r;
  };

  while (i < pattern.length) {
    const ch = pattern.charAt(i);

    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern.charAt(i + 1);

      // `\p{…}` / `\P{…}` — pass through category classes JS recognises;
      // approximate block escapes (e.g. `\p{IsBasicLatin}`) it does not.
      if (next === 'p' || next === 'P') {
        const m = /^\\[pP]\{([^}]*)\}/.exec(pattern.slice(i));
        if (m) {
          if (isJsUnicodeProperty(next, m[1])) {
            out += m[0];
          } else {
            flag(`Unicode property \\${next}{${m[1]}} has no JS equivalent`);
            out += inClass ? ANY_INSIDE_CLASS : ANY_OUTSIDE_CLASS;
          }
          i += m[0].length;
          continue;
        }
        out += ch + next;
        i += 2;
        continue;
      }

      const mapped = mapEscape(next, inClass);
      if (mapped === UNSUPPORTED_IN_CLASS) {
        flag(`\\${next} cannot be expressed inside a character class in JS`);
        out += ANY_INSIDE_CLASS;
      } else if (mapped !== undefined) {
        out += mapped;
      } else {
        // Pass through any other escape (`\n`, `\.`, `\\`, `\[`, …).
        out += ch + next;
      }
      i += 2;
      continue;
    }

    if (ch === '[' && !inClass) {
      // Char-class subtraction `[a-z-[aeiou]]` has no JS equivalent.
      if (/^\[[^\]]*-\[/.test(pattern.slice(i))) {
        flag('XSD character-class subtraction is not supported in JS regex');
      }
      inClass = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      out += ch;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return { pattern: out, supported: reason === '', reason };
}

/** Sentinel: escape has no faithful form inside a `[ … ]` character class. */
const UNSUPPORTED_IN_CLASS = '\0unsupported-in-class';

/**
 * Map an XSD-specific escape to its JS Unicode-property equivalent.
 * Returns `undefined` when the escape is identical in both dialects (and
 * thus needs no translation), or `UNSUPPORTED_IN_CLASS` when the escape
 * is a negated class that can't be inlined inside `[ … ]`.
 *
 * The XML production rules these escapes implement live in the W3C XML
 * 1.0 spec § 2.3 (NameStartChar / NameChar) and § 2.5 (Digit / Letter).
 * JS Unicode property escapes (`\p{L}`, `\p{Nd}`) are equivalent for our
 * purposes under the `u` flag. `inClass` selects the bare-members form
 * so the result can be spliced into a surrounding class.
 */
function mapEscape(ch: string, inClass: boolean): string | undefined {
  switch (ch) {
    case 'i':
      // NameStartChar: letters + `_` + `:` + extended Unicode letters.
      return inClass ? '\\p{L}_:' : '[\\p{L}_:]';
    case 'c':
      // NameChar: NameStartChar + digits + `.` + `-` + U+00B7 + combining marks.
      return inClass
        ? '\\p{L}\\p{Nd}_:.\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040'
        : '[\\p{L}\\p{Nd}_:.\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040]';
    case 'd':
      // JS \d matches `[0-9]`; XSD \d matches all Unicode digits.
      return '\\p{Nd}';
    case 'D':
      return '\\P{Nd}';
    case 'w':
      // JS \w matches `[A-Za-z0-9_]`; XSD \w is Unicode letters + digits
      // without underscore.
      return inClass ? '\\p{L}\\p{Nd}' : '[\\p{L}\\p{Nd}]';
    case 'I':
      return inClass ? UNSUPPORTED_IN_CLASS : '[^\\p{L}_:]';
    case 'C':
      return inClass
        ? UNSUPPORTED_IN_CLASS
        : '[^\\p{L}\\p{Nd}_:.\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040]';
    case 'W':
      return inClass ? UNSUPPORTED_IN_CLASS : '[^\\p{L}\\p{Nd}]';
    default:
      return undefined;
  }
}

/**
 * Whether JS's Unicode regex dialect recognises the property name in a
 * `\p{name}` / `\P{name}` escape. Delegates to the engine itself rather
 * than maintaining a name list — XSD `\p{L}` etc. compile, while block
 * escapes like `\p{IsBasicLatin}` throw.
 */
function isJsUnicodeProperty(pOrP: string, name: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(`\\${pOrP}{${name}}`, 'u');
    return true;
  } catch {
    return false;
  }
}
