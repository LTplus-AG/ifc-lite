/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical XSD-regex → JavaScript-regex translator shared by the
 * constraint matcher (`matchPattern`) and the document auditor
 * (`audit/coherence`). Keeping a single implementation avoids the two
 * dialects drifting apart.
 *
 * Follows XML Schema Part 2, Appendix F. Where the dialects differ:
 *
 *  - No anchors: XSD patterns always match the whole value, so `^` and
 *    `$` are ordinary characters. Outside a class they become `\^` / `\$`
 *    (#7400), except that a pattern-initial `^` and pattern-final `$` are
 *    dropped as redundant anchors for compatibility with IDS files written
 *    for regex dialects that have them (`^.*$`, #1097). Inside a class `^`
 *    negates only in first position, as in JS.
 *  - `.` is `[^\n\r]` (JS `.` also excludes U+2028 / U+2029).
 *  - Single-character escapes `\n \r \t \\ \| \. \? \* \+ \( \) \{ \}
 *    \- \[ \] \^` are literals. `\-` is emitted as `-` outside a class,
 *    where the `u` flag rejects it (#7400). `\/` and `\$` are accepted as
 *    lenient extensions (common in authored IDS, and unambiguous); any
 *    other escape is not XSD and is reported as unsupported.
 *  - Multi-character escapes: `\s` is only space, tab, CR, LF; `\d` is
 *    `\p{Nd}`; `\w` is every character outside `\p{P}`, `\p{Z}`, `\p{C}`
 *    (the Appendix F definition; until #7400 this was approximated as
 *    `[\p{L}\p{Nd}]`, which wrongly excluded symbols and marks); `\i` / `\c`
 *    approximate the XML 1.0 NameStartChar / NameChar productions. Upper
 *    case is the complement.
 *  - `\p{IsBlock}` / `\P{IsBlock}` name a Unicode block (Appendix F.1.1),
 *    translated to its code-point range(s) (`xsd-regex-blocks.ts`).
 *    Category escapes (`\p{Lu}`) pass through: JS knows the same names.
 *  - Class subtraction `[a-z-[aeiou]]` is translated exactly to a negative
 *    lookahead (`translateSubtraction`).
 *
 * A class whose member is a complement (`[a\W]`, `[x\P{IsBasicLatin}]`)
 * cannot be spliced into one JS `[ … ]` without the ES2024 `v` flag's set
 * operations, which this package does not rely on (its ES2022 browser
 * baseline predates them). Instead the class is rewritten as a union,
 * `[a\W]` → `(?:[a]|[\p{P}\p{Z}\p{C}])`, and a negated one as an
 * intersection via single-character lookaheads, `[^a\w]` →
 * `(?:(?![a])[\p{P}\p{Z}\p{C}])`. Both consume exactly one character and
 * are exact, like the subtraction translation.
 *
 * The compiled `RegExp` MUST use the `u` flag. A construct with no exact
 * JS form (an unknown block or property name, an escape XSD does not
 * define, an undelimitable subtraction) sets `supported: false` with a
 * reason; the matcher then refuses the pattern instead of guessing.
 */

import { xsdBlockClassMembers } from './xsd-regex-blocks.js';

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
 * `TranslateResult.reason` when the pattern uses XSD character-class
 * subtraction that cannot be delimited (`[a-z-[aeiou]`).
 */
const SUBTRACTION_UNSUPPORTED_REASON =
  'XSD character-class subtraction is not supported in JS regex';

/**
 * A character set produced by an escape: `members` can be spliced inside
 * `[ … ]`; when `negated`, the set is the complement of `members`. `bare`
 * marks a single atom (`\p{Nd}`) usable outside a class without brackets.
 */
interface CharSet {
  members: string;
  negated: boolean;
  bare?: boolean;
}

type Escape =
  | { kind: 'char'; inside: string; outside: string; length: number }
  | { kind: 'set'; set: CharSet; length: number }
  | { kind: 'error'; reason: string; length: number };

const S_MEMBERS = '\\x20\\t\\n\\r';
const I_MEMBERS = '\\p{L}_:';
const C_MEMBERS = '\\p{L}\\p{Nd}_:.\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040';
/** `\W`: XSD `\w` is `[#x0000-#x10FFFF]-[\p{P}\p{Z}\p{C}]`. */
const W_COMPLEMENT = '\\p{P}\\p{Z}\\p{C}';

const MULTI_CHAR_ESCAPES: Readonly<Record<string, CharSet>> = {
  s: { members: S_MEMBERS, negated: false },
  S: { members: S_MEMBERS, negated: true },
  i: { members: I_MEMBERS, negated: false },
  I: { members: I_MEMBERS, negated: true },
  c: { members: C_MEMBERS, negated: false },
  C: { members: C_MEMBERS, negated: true },
  d: { members: '\\p{Nd}', negated: false, bare: true },
  D: { members: '\\P{Nd}', negated: false, bare: true },
  w: { members: W_COMPLEMENT, negated: true },
  W: { members: W_COMPLEMENT, negated: false },
};

/** XSD `SingleCharEsc` characters, plus the lenient `/` and `$`. */
const SINGLE_CHAR_ESCAPES = new Set('nrt\\|.?*+(){}-[]^/$');

/**
 * Translate the XSD pattern. Returns the JS-compatible pattern plus a
 * `supported` flag — when `false`, `reason` names the construct that has
 * no exact JS form and the pattern must not be trusted.
 */
export function translateXsdRegex(pattern: string): TranslateResult {
  let reason = '';
  // The first reason wins, except that an undelimitable subtraction always
  // does: it is the most specific diagnostic (review on #5286).
  const flag = (r: string) => {
    if (!reason || r === SUBTRACTION_UNSUPPORTED_REASON) reason = r;
  };

  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);

    if (ch === '\\') {
      const esc = readEscape(pattern, i);
      i += esc.length;
      if (esc.kind === 'error') {
        flag(esc.reason);
        out += ANY_OUTSIDE_CLASS;
      } else if (esc.kind === 'char') {
        out += esc.outside;
      } else {
        out += setAtom(esc.set);
      }
      continue;
    }

    if (ch === '[') {
      const span = scanClass(pattern, i);
      if (!span) {
        // Unterminated: refuse an apparent subtraction rather than guess
        // which characters it excludes; anything else stays verbatim and
        // fails to compile, which the auditor reports as an error.
        if (/^\[[^\]]*-\[/.test(pattern.slice(i))) flag(SUBTRACTION_UNSUPPORTED_REASON);
        out += pattern.slice(i);
        break;
      }
      out += span.subtract
        ? translateSubtraction(pattern, span, flag)
        : translateClass(pattern, span.start + 1, span.baseEnd, flag);
      i = span.end;
      continue;
    }

    if (ch === '^' || ch === '$') {
      // Compatibility: a pattern-initial `^` and pattern-final `$` are
      // dropped as redundant anchors (the match is whole-value anyway),
      // as the reference implementation's `re.fullmatch` reads them —
      // `^.*$` is a common IDS idiom (#1097). Everywhere else they are the
      // literal characters XSD defines (`US$?`, `a$b`; #7400).
      const isEdgeAnchor = ch === '^' ? i === 0 : i === pattern.length - 1 && i > 0;
      if (!isEdgeAnchor) out += `\\${ch}`;
    } else if (ch === '.') out += '[^\\n\\r]';
    else out += ch;
    i++;
  }

  return { pattern: out, supported: reason === '', reason };
}

/** Read the escape starting at `pattern[i] === '\\'`. */
function readEscape(pattern: string, i: number): Escape {
  const next = pattern.charAt(i + 1);
  if (next === '') {
    return { kind: 'error', reason: 'pattern ends with a lone backslash', length: 1 };
  }
  if (next === 'p' || next === 'P') {
    const m = /^\\[pP]\{([^}]*)\}/.exec(pattern.slice(i));
    if (!m) {
      return { kind: 'error', reason: `\\${next} must be followed by {name}`, length: 2 };
    }
    const name = m[1];
    const length = m[0].length;
    if (name.startsWith('Is')) {
      const members = xsdBlockClassMembers(name.slice(2));
      if (members === undefined) {
        return {
          kind: 'error',
          reason: `\\${next}{${name}} names no Unicode block XML Schema defines`,
          length,
        };
      }
      return { kind: 'set', set: { members, negated: next === 'P' }, length };
    }
    if (!isJsUnicodeProperty(next, name)) {
      return { kind: 'error', reason: `Unicode property \\${next}{${name}} has no JS equivalent`, length };
    }
    return { kind: 'set', set: { members: m[0], negated: false, bare: true }, length };
  }
  const multi = MULTI_CHAR_ESCAPES[next];
  if (multi) return { kind: 'set', set: multi, length: 2 };
  if (SINGLE_CHAR_ESCAPES.has(next)) {
    const escaped = `\\${next}`;
    return { kind: 'char', inside: escaped, outside: next === '-' ? '-' : escaped, length: 2 };
  }
  return { kind: 'error', reason: `\\${next} is not a valid XSD regex escape`, length: 2 };
}

/** A set as a standalone atom outside any class. */
function setAtom(set: CharSet): string {
  if (set.negated) return `[^${set.members}]`;
  return set.bare ? set.members : `[${set.members}]`;
}

/**
 * Translate the class body `pattern[from, to)` (without brackets) into an
 * expression that consumes exactly one character. Positive members are
 * collected into one JS class; complemented members (`\W`, `\S`, `\I`,
 * `\C`, `\w`, `\P{Is…}`) are combined by union or, for a negated class,
 * intersection — see the module comment.
 */
function translateClass(pattern: string, from: number, to: number, flag: (r: string) => void): string {
  let j = from;
  const negated = pattern.charAt(j) === '^' && j + 1 < to;
  if (negated) j++;
  let positive = '';
  const complements: string[] = [];
  while (j < to) {
    const ch = pattern.charAt(j);
    if (ch !== '\\') {
      positive += ch;
      j++;
      continue;
    }
    const esc = readEscape(pattern, j);
    j += esc.length;
    if (esc.kind === 'error') {
      flag(esc.reason);
      positive += ANY_INSIDE_CLASS;
    } else if (esc.kind === 'char') {
      positive += esc.inside;
    } else if (esc.set.negated) {
      complements.push(esc.set.members);
    } else {
      positive += esc.set.members;
    }
  }

  if (complements.length === 0) return negated ? `[^${positive}]` : `[${positive}]`;
  if (!negated) {
    // [P ∪ ¬S1 ∪ … ∪ ¬Sn]
    const alternatives = complements.map((c) => `[^${c}]`);
    if (positive) alternatives.unshift(`[${positive}]`);
    return alternatives.length === 1 ? alternatives[0] : `(?:${alternatives.join('|')})`;
  }
  // [^P ∪ ¬S1 ∪ … ∪ ¬Sn] = S1 ∩ … ∩ Sn ∩ ¬P
  const [first, ...rest] = complements;
  const guards = rest.map((c) => `(?=[${c}])`).join('') + (positive ? `(?![${positive}])` : '');
  return guards ? `(?:${guards}[${first}])` : `[${first}]`;
}

/**
 * One bracketed class starting at `start` (which holds `[`). `baseEnd` is
 * the index just past the base members; `subtract` is the nested excluded
 * class when the base is followed by `-[`, and `end` is just past the
 * closing `]`. `undefined` when the class is unterminated. XSD allows a
 * subtraction only as the last item of a class, so after the nested class
 * the next character must be the outer `]`.
 */
interface ClassSpan {
  start: number;
  baseEnd: number;
  subtract?: ClassSpan;
  end: number;
}

function scanClass(pattern: string, start: number): ClassSpan | undefined {
  let j = start + 1;
  while (j < pattern.length) {
    const c = pattern.charAt(j);
    if (c === '\\') {
      const prop = /^\\[pP]\{[^}]*\}/.exec(pattern.slice(j));
      j += prop ? prop[0].length : 2;
      continue;
    }
    if (c === '-' && pattern.charAt(j + 1) === '[') {
      const subtract = scanClass(pattern, j + 1);
      if (!subtract || pattern.charAt(subtract.end) !== ']') return undefined;
      return { start, baseEnd: j, subtract, end: subtract.end + 1 };
    }
    if (c === ']') return { start, baseEnd: j, end: j + 1 };
    j++;
  }
  return undefined;
}

/**
 * `[base-[excluded]]` matches one character that is in `base` and not in
 * `excluded`. JS under the `u` flag has no class subtraction, but the same
 * single-character set is `(?:(?!excluded)base)`: the negative lookahead
 * refuses an excluded character and the base class then consumes one. This
 * is exact, not an approximation, and it nests for `[a-z-[b-y-[c]]]`.
 */
function translateSubtraction(pattern: string, span: ClassSpan, flag: (r: string) => void): string {
  const base = translateClass(pattern, span.start + 1, span.baseEnd, flag);
  const sub = span.subtract!;
  const excluded = sub.subtract
    ? translateSubtraction(pattern, sub, flag)
    : translateClass(pattern, sub.start + 1, sub.baseEnd, flag);
  return `(?:(?!${excluded})${base})`;
}

/**
 * Whether JS's Unicode regex dialect recognises the property name in a
 * `\p{name}` / `\P{name}` escape. Delegates to the engine itself rather
 * than maintaining a name list; XSD category names (`L`, `Nd`, …) compile.
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
