/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The detector `check-i18n-literals.mjs` runs: an AST walk for hardcoded
 * JSX text and `aria-label`/`title`/`placeholder`/`alt` string literals,
 * the #4918 charter's "what ends it" gate. Split into its own module so
 * `check-i18n-literals.test.mjs` can assert the DETECTOR (a hardcoded
 * literal caught, an allowlisted `IfcWall` not) independent of the CLI's
 * file-walking and baseline bookkeeping.
 *
 * A REAL PARSE, NOT A REGEX (review on PR #4973 replaced the original
 * regex version of this file): a regex pass over `>text<` false-positived
 * on any ordinary comparison (`if (a > b) return <div />`) and false
 * -negatived on the `{'…'}` JSX-expression spelling of JSX text
 * (`<button>{'Save changes'}</button>`, `aria-label={'…'}`) — both wrong
 * in the direction that matters for a ratchet meant to hold a line. Using
 * the same `typescript` compiler API `check-wasm-disposal.mjs` and
 * `check-api-surface.mjs` already load removes both classes of defect by
 * construction: only real `JsxText`/`JsxExpression`/`JsxAttribute` nodes
 * are ever visited, so `a > b` produces no `JsxText` at all, and
 * `{'Save changes'}` is a `JsxExpression` whose expression IS a string
 * literal, which this walk asks about directly (no guessing from `{}`
 * balance). A mixed `Hello {name}` counts once — `name` is an
 * `Identifier`, not a string literal, so only the static `"Hello "`
 * `JsxText` node is a candidate.
 *
 * The parser is intentionally lenient (`createSourceFile` never throws on
 * malformed input; it recovers and keeps walking), matching this file's
 * own nature as a RATCHET rather than a hard gate: a syntax error elsewhere
 * in a file must not blind the walk to the JSX nodes it can still see.
 */

import ts from 'typescript';

/** Attribute names this gate polices — the charter's `aria-label`/`title`,
 *  plus `placeholder` (kept from the original version) and `alt` (review:
 *  an image's accessible text is exactly the same class of hardcoded
 *  user-facing copy). */
const TARGET_ATTRS = new Set(['aria-label', 'title', 'placeholder', 'alt']);

/** A single IFC EXPRESS entity/type name, e.g. `IfcWall`, `IfcSpaceType`. */
const IFC_NAME_RE = /^Ifc[A-Z][A-Za-z0-9]*$/;

/**
 * An explicit technical-acronym allowlist — NOT "any all-caps word": review
 * caught that a broader `^[A-Z][A-Z0-9]*$` pattern also allowlisted real UI
 * copy like `DELETE` or `WELCOME`. Extend this list rather than widening it
 * into a pattern.
 */
const ACRONYMS = new Set([
  'PDF', 'CSV', 'GLB', 'BCF', 'IDS', 'JSON', 'USD', 'URL', 'ID', 'IFC',
  'KMZ', 'GLTF', 'STEP', 'HTML', 'CSS', 'SDK', 'API', 'CDE', 'MEP', 'GFA',
  '3D', '4D',
]);

/** Unicode-aware: no LETTER of any script at all — punctuation, digits,
 *  whitespace runs all still have zero `\p{L}` code points, so this only
 *  spares genuinely letter-free text, never a non-Latin word (`设置`/
 *  `你好` must NOT be allowlisted here). */
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

/** The string VALUE of a literal expression, or `null` if `expr` is not
 *  one — a plain string literal or a no-substitution template literal
 *  (`` `Save changes` ``, no `${}` inside it). A template literal WITH
 *  interpolation is correctly left alone: its value isn't static text. */
function literalStringValue(expr) {
  if (ts.isStringLiteral(expr)) return expr.text;
  if (ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return null;
}

/**
 * Parse `source` as TSX and return every candidate literal: `JsxText`
 * nodes with non-whitespace content, `JsxExpression`s wrapping a string
 * literal (the `{'…'}` spelling of JSX text or an attribute value), and
 * `aria-label`/`title`/`placeholder`/`alt` `JsxAttribute`s set to a
 * string literal (plain or expression-wrapped) — BEFORE allowlist
 * filtering. Exported mainly for the detector's own tests.
 */
export function findLiterals(source, fileName = 'fixture.tsx') {
  const found = [];
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  /** JsxAttribute nodes are visited once by name below; tracking their
   *  JsxExpression initializer's node lets the generic JsxExpression visit
   *  skip it, so an attribute value is never counted twice. */
  const consumedExpressions = new Set();

  function pushIfText(kind, raw) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length > 0) found.push({ kind, text });
  }

  function visit(node) {
    if (ts.isJsxText(node)) {
      pushIfText('jsx-text', node.getText());
    } else if (ts.isJsxAttribute(node) && TARGET_ATTRS.has(node.name.getText())) {
      const init = node.initializer;
      if (init) {
        if (ts.isStringLiteral(init)) {
          pushIfText('attr', init.text);
        } else if (ts.isJsxExpression(init) && init.expression) {
          const lit = literalStringValue(init.expression);
          if (lit !== null) {
            consumedExpressions.add(init);
            pushIfText('attr', lit);
          }
        }
      }
    } else if (ts.isJsxExpression(node) && node.expression && !consumedExpressions.has(node)) {
      const lit = literalStringValue(node.expression);
      if (lit !== null) pushIfText('jsx-expression-string', lit);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/** Count of non-allowlisted literals in `source` — what the per-file
 *  baseline records and the gate compares against. */
export function countLiterals(source, fileName = 'fixture.tsx') {
  return findLiterals(source, fileName).filter((lit) => !isAllowlistedLiteral(lit.text)).length;
}
