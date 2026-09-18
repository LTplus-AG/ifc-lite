/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The detector `check-i18n-literals.mjs` runs: a grep-based scan for
 * hardcoded JSX text and `aria-label`/`title`/`placeholder` string
 * literals, the #4918 charter's "what ends it" gate. Split into its own
 * module so `check-i18n-literals.test.mjs` can assert the DETECTOR (a
 * hardcoded literal caught, an allowlisted `IfcWall` not) independent of
 * the CLI's file-walking and baseline bookkeeping.
 *
 * DELIBERATELY A REGEX, NOT A PARSER: `check-source-text-assertions.mjs`
 * and its Rust twin earn a real lexer because their precision is the whole
 * point of that gate. This one is a RATCHET — the charter asks for
 * "a grep-based gate" — so a good-enough regex that a per-file baseline
 * absorbs today's false positives against is the right shape: the number
 * only needs to go down over time, not be exact on day one. Known
 * over-matches: a generic type parameter (`Array<string>`) or a comparison
 * (`a > b`) can look like JSX text. Known under-matches: a `t()` call, a
 * variable, or a genuine `{expr}`/`{fn()}` expression is correctly ignored
 * (dynamic content is out of scope), and so is a literal built by string
 * concatenation — both stay findable as a bigger count in a specific
 * file's baseline row, rather than fixed on the gate's word alone. A bare
 * quoted string inside `{}` (`{'Save changes'}`, `aria-label={"…"}`) IS
 * caught (`JSX_EXPRESSION_STRING_RE`) — that shape is common enough (any
 * JSX text containing a quote character) that leaving it out would make
 * the ratchet trivially easy to dodge.
 */

/**
 * JSX text nodes: whatever sits between a `>` and the next `<`, provided it
 * contains a letter (an empty run, or one of just whitespace/punctuation, is
 * layout, not copy). Spans newlines — `<div>\n  No results\n</div>` is a
 * real, common shape in this codebase — so the character class excludes
 * only the delimiters `{}<>`, not `\n`.
 */
const JSX_TEXT_RE = />([^<>{}]*\p{L}[^<>{}]*)</gu;

/**
 * A JSX EXPRESSION container holding nothing but a single quoted string
 * literal — `{'Save changes'}` or `{"Save changes"}` — the ordinary way to
 * write JSX text that itself contains a quote character. Indistinguishable
 * from `JSX_TEXT_RE`'s exclusion of `{}` unless matched on its own: review
 * caught that the original version missed this shape entirely.
 */
const JSX_EXPRESSION_STRING_RE = /\{\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*\}/g;

/** `aria-label`/`title`/`placeholder` set to a quoted STRING LITERAL —
 *  either directly (`aria-label="…"`) or as a JSX expression holding only a
 *  string (`aria-label={'…'}`) — never a `{expr}`/`{fn()}` expression, which
 *  is already dynamic (a `t()` call or a variable) and out of this gate's
 *  scope. Whitespace around `=` is tolerated (`aria-label = "…"` parses);
 *  the negative lookbehind keeps `data-title`/`data-placeholder` (ordinary
 *  data attributes, not this gate's business) from matching on their
 *  `-title`/`-placeholder` suffix.
 */
const ATTR_RE = /(?<![\w-])(?:aria-label|title|placeholder)\s*=\s*(?:(["'])((?:(?!\1)[^\\]|\\.)*)\1|\{\s*(["'])((?:(?!\3)[^\\]|\\.)*)\3\s*\})/g;

/** A single IFC EXPRESS entity/type name, e.g. `IfcWall`, `IfcSpaceType`. */
const IFC_NAME_RE = /^Ifc[A-Z][A-Za-z0-9]*$/;

/**
 * An explicit technical-acronym allowlist — NOT "any all-caps word": review
 * caught that `^[A-Z][A-Z0-9]*$` also allowlisted real UI copy like `DELETE`
 * or `WELCOME`. Extend this list rather than widening the pattern.
 */
const ACRONYMS = new Set([
  'PDF', 'CSV', 'GLB', 'BCF', 'IDS', 'JSON', 'USD', 'URL', 'ID', 'IFC',
  'KMZ', 'GLTF', 'STEP', 'HTML', 'CSS', 'SDK', 'API', 'CDE', 'MEP', 'GFA',
  '3D', '4D',
]);

/** Unicode-aware: no LETTER of any script at all — punctuation, digits,
 *  whitespace runs, CJK/Cyrillic/etc. text all still have `\p{L}` code
 *  points, so this only spares genuinely letter-free text, never a
 *  non-Latin word (review: `设置`/`你好` must NOT be allowlisted here). */
const NO_LETTERS_RE = /\p{L}/u;

/** Non-ASCII symbol/unit characters: `°`, `²`, `³`, `×`, en/em dashes, curly
 *  quotes, prime marks, currency, and the general "Arrows"–"Miscellaneous
 *  Symbols" Unicode blocks a keyboard glyph (`⌘`, `⇧`, `↑`) comes from. */
const SYMBOL_CHAR_RE = /[°²³×‐-―‘-‟′-⁄₠-⃏℀-⯿]/;

/**
 * A keyboard-shortcut glyph cluster (`⌘Z`, `⇧⌘K`) or a bare unit (`m²`,
 * `°C`, `%`): at most ONE plain ASCII letter — enough to reject a real
 * short word like "Home" or "Open" (all letters) — short overall, and
 * built from symbol/digit characters otherwise.
 */
function isSymbolOrUnitCluster(text) {
  if (text.length === 0 || text.length > 4) return false;
  const letters = text.match(/[A-Za-z]/g) ?? [];
  if (letters.length > 1) return false;
  if (SYMBOL_CHAR_RE.test(text)) return true;
  return /^[0-9.,+\-−%]+$/.test(text);
}

/**
 * Allowlisted per the #4918 charter: IFC EXPRESS names, uppercase STEP/
 * technical identifiers, and short unit/symbol clusters. Applied to the
 * TRIMMED, whitespace-collapsed literal — multi-word prose never matches
 * any of these on its own.
 */
export function isAllowlistedLiteral(raw) {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return true; // pure whitespace: not copy
  if (!NO_LETTERS_RE.test(text)) return true; // no letters in any script: not copy
  if (IFC_NAME_RE.test(text)) return true;
  if (ACRONYMS.has(text)) return true;
  if (isSymbolOrUnitCluster(text)) return true;
  return false;
}

/**
 * Every candidate literal in `source`: JSX text runs (plain, and the
 * `{'…'}` expression-wrapped spelling of the same thing) and quoted
 * `aria-label`/`title`/`placeholder` attribute values (plain or
 * expression-wrapped), BEFORE allowlist filtering. Exported mainly for the
 * detector's own tests.
 */
export function findLiterals(source) {
  const found = [];
  // ATTR_RE runs first and its matched spans are recorded: an
  // expression-wrapped attribute value (`aria-label={'…'}`) matches BOTH
  // this pattern and JSX_EXPRESSION_STRING_RE's generic "quoted string
  // inside `{}`" shape, so the latter must skip any span ATTR_RE already
  // claimed or the same literal is counted twice (review caught this).
  const attrSpans = [];
  for (const m of source.matchAll(ATTR_RE)) {
    const text = (m[2] ?? m[4] ?? '').replace(/\s+/g, ' ').trim();
    attrSpans.push([m.index, m.index + m[0].length]);
    if (text.length > 0) found.push({ kind: 'attr', text });
  }
  for (const m of source.matchAll(JSX_TEXT_RE)) {
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (text.length > 0) found.push({ kind: 'jsx-text', text });
  }
  for (const m of source.matchAll(JSX_EXPRESSION_STRING_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (attrSpans.some(([s, e]) => start < e && end > s)) continue; // already counted via ATTR_RE
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (text.length > 0) found.push({ kind: 'jsx-expression-string', text });
  }
  return found;
}

/** Count of non-allowlisted literals in `source` — what the per-file
 *  baseline records and the gate compares against. */
export function countLiterals(source) {
  return findLiterals(source).filter((lit) => !isAllowlistedLiteral(lit.text)).length;
}
