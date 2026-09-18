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
 * (`a > b`) can look like JSX text; a template-literal `aria-label={...}`
 * is correctly ignored (only quoted literals count) but a literal built by
 * string concatenation is not, so it under-matches too. Both stay findable
 * — a bigger count in a specific file's baseline row — rather than fixed
 * on the gate's word alone.
 */

/**
 * JSX text nodes: whatever sits between a `>` and the next `<`, provided it
 * contains a letter (an empty run, or one of just whitespace/punctuation, is
 * layout, not copy). Spans newlines — `<div>\n  No results\n</div>` is a
 * real, common shape in this codebase — so the character class excludes
 * only the delimiters `{}<>`, not `\n`.
 */
const JSX_TEXT_RE = />([^<>{}]*[A-Za-z][^<>{}]*)</g;

/** `aria-label`/`title`/`placeholder` set to a quoted STRING LITERAL — never
 *  a `{...}` expression, which is already dynamic (a `t()` call or a
 *  variable) and out of this gate's scope. */
const ATTR_RE = /\b(?:aria-label|title|placeholder)=(["'])((?:(?!\1)[^\\]|\\.)*)\1/g;

/** A single IFC EXPRESS entity/type name, e.g. `IfcWall`, `IfcSpaceType`. */
const IFC_NAME_RE = /^Ifc[A-Z][A-Za-z0-9]*$/;

/** An all-caps technical acronym with no spaces: `PDF`, `CSV`, `GLB`, `BCF`,
 *  `IDS`, `JSON`, `USD`, `URL`, `ID`, `IFC`, `3D`, `4D` and similar. */
const ACRONYM_RE = /^[A-Z][A-Z0-9]*$/;

/** No letters at all — punctuation, digits, whitespace runs — is never copy. */
const NO_LETTERS_RE = /[A-Za-z]/;

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
  if (!NO_LETTERS_RE.test(text)) return true; // no letters: not copy
  if (IFC_NAME_RE.test(text)) return true;
  if (ACRONYM_RE.test(text)) return true;
  if (isSymbolOrUnitCluster(text)) return true;
  return false;
}

/**
 * Every candidate literal in `source`: JSX text runs and quoted
 * `aria-label`/`title`/`placeholder` attribute values, BEFORE allowlist
 * filtering. Exported mainly for the detector's own tests.
 */
export function findLiterals(source) {
  const found = [];
  for (const m of source.matchAll(JSX_TEXT_RE)) {
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (text.length > 0) found.push({ kind: 'jsx-text', text });
  }
  for (const m of source.matchAll(ATTR_RE)) {
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (text.length > 0) found.push({ kind: `attr`, text });
  }
  return found;
}

/** Count of non-allowlisted literals in `source` — what the per-file
 *  baseline records and the gate compares against. */
export function countLiterals(source) {
  return findLiterals(source).filter((lit) => !isAllowlistedLiteral(lit.text)).length;
}
