/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether a literal is in the lexical space of an `xs:restriction @base`.
 *
 * Moved here from `audit/coherence` so the restriction PARSER can ask the
 * same question the auditor asks (#7399): a bound is read under its base, and
 * the parser may not import from `audit/`. One answer, two callers, so an
 * enumeration value and a bound under the same base cannot disagree.
 */

import { XSD_NUMERIC_SPECIALS } from './xsd-cast.js';
import { isValidXsdDateTimeLiteral, isXsdDateTimeBase } from './xsd-datetime.js';

/**
 * Validate that `value` matches the lexical space of the supplied XSD
 * primitive base. Mirrors upstream `XsTypes.IsValid` (see the table, and the
 * date family it hands off); flags `<xs:enumeration value="12,0"/>` under
 * `<xs:restriction base="xs:double">`.
 */
const XS_VALUE_REGEX: Record<string, RegExp> = {
  // Upstream `XmlRegex.cs`, except the mantissa: `[0-9]*(?:\.[0-9]*)?` not
  // `[0-9]*\.?[0-9]*`, whose two adjacent digit runs make a failing lexeme
  // retry every split (quadratic, #3113). Same language, one parse/prefix.
  'xs:integer': /^[+-]?(\d+)$/,
  'xs:double': /^([-+]?[0-9]*(?:\.[0-9]*)?([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$/,
  'xs:float': /^([-+]?[0-9]*(?:\.[0-9]*)?([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$/,
  'xs:decimal': /^([-+]?[0-9]*(?:\.[0-9]*)?([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$/,
  'xs:boolean': /^(true|false|0|1)$/,
  // The date family is absent on purpose: its value space is a calendar, not a
  // digit-run shape, so it goes through `isValidXsdDateTimeLiteral` (#3721).
  'xs:duration': /^[-+]?P(\d+Y)?(\d+M)?(\d+D)?(T(\d+H)?(\d+M)?(\d+S)?)?$/,
};

export function isValidLexicalForXsType(value: string, base: string): boolean {
  if (isXsdDateTimeBase(base)) return isValidXsdDateTimeLiteral(value, base);
  const rx = XS_VALUE_REGEX[base];
  if (!rx) return true; // base we don't recognise → don't fabricate errors
  if (base === 'xs:double' || base === 'xs:float' || base === 'xs:decimal') {
    // Digit required in the MANTISSA, specials exempt (#3336). Testing the
    // whole lexeme accepted 'e5' on the exponent's digit and rejected the
    // digitless specials, which is how this and `literalCastsUnder` disagreed.
    const bare = !XSD_NUMERIC_SPECIALS.has(value);
    if (bare && !/[0-9]/.test(value.split(/[eE]/)[0])) return false;
  }
  return rx.test(value);
}
