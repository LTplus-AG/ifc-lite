/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon icon design-contract guard.
 *
 * Every ribbon button glyph comes from the house set in `src/icons/` and is
 * re-exported by `@/icons`. The vite loader (`apps/viewer/vite.config.ts`)
 * rewrites exactly two paint literals in those files — `#000000` →
 * `currentColor` and `#0063B1` → `var(--viewer-icon-accent)` — and the
 * house icons are outlines traced as filled paths 1 user unit wide.
 *
 * A `lucide-react` glyph on a ribbon button breaks that contract on the two
 * axes a user sees at a glance: it is a `stroke-width="2"` stroke in the
 * same 24 viewBox (twice the weight of every neighbour) and 100 %
 * `currentColor` (no accent, no dark-mode adaptation). Eight such glyphs
 * shipped — Reposition, Zones, Load Report, Appearance, World, Move georef,
 * Follow work, Classic bar — because nothing checked. This does, both ways:
 *
 * 1. Every `icon={X}` on a RibbonLargeButton / RibbonSmallButton under
 *    `ribbon/tabs/` must be an identifier imported from `@/icons` (read from
 *    the TypeScript AST, so a stray import or a name in a comment does not
 *    count).
 * 2. Every icon `@/icons` exports must resolve to an SVG in `src/icons/` that
 *    honours the loader contract: 24-unit viewBox, painted colours limited
 *    to the two literals the loader rewrites (or `none`), and any stroke no
 *    heavier than the house weight (1.2 — `file-pdf.svg` is the one
 *    stroke-based icon; lucide's 2 is rejected).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../..');
const TABS_DIR = path.join(HERE, 'tabs');
const ICONS_DIR = path.join(SRC, 'icons');
const ICONS_INDEX = path.join(ICONS_DIR, 'index.ts');

const RIBBON_BUTTONS = new Set(['RibbonLargeButton', 'RibbonSmallButton']);

/** Paints the vite loader rewrites (see `customCollections.viewer`), plus `none`. */
const ALLOWED_PAINTS = new Set(['#000000', '#0063B1', 'rgba(0, 99, 177, 1)', 'none']);
/** House line weight in user units. `file-pdf.svg` strokes at 1.1–1.2; lucide strokes at 2. */
const MAX_STROKE_WIDTH = 1.2;

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Imported local names, keyed by module specifier. */
function importsByModule(sf: ts.SourceFile): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const names = new Set<string>();
    const clause = stmt.importClause;
    if (clause?.name) names.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) names.add(el.name.text);
    }
    out.set(stmt.moduleSpecifier.text, new Set([...(out.get(stmt.moduleSpecifier.text) ?? []), ...names]));
  }
  return out;
}

/** `{ line, iconExpr }` for every `icon=` attribute on a ribbon button element. */
function ribbonButtonIcons(sf: ts.SourceFile): Array<{ line: number; icon: string }> {
  const found: Array<{ line: number; icon: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (RIBBON_BUTTONS.has(tag)) {
        for (const attr of node.attributes.properties) {
          if (ts.isJsxAttribute(attr) && attr.name.getText(sf) === 'icon' && attr.initializer) {
            const init = attr.initializer;
            const expr = ts.isJsxExpression(init) && init.expression ? init.expression.getText(sf) : init.getText(sf);
            found.push({ line: sf.getLineAndCharacterOfPosition(attr.getStart(sf)).line + 1, icon: expr });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** `Name -> icon file basename` for every `export { default as Name } from '~icons/viewer/<file>'`. */
function houseIconExports(): Map<string, string> {
  const sf = parse(ICONS_INDEX);
  const out = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const m = /^~icons\/viewer\/(.+)$/.exec(stmt.moduleSpecifier.text);
    if (!m || !stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
    for (const el of stmt.exportClause.elements) out.set(el.name.text, m[1]);
  }
  return out;
}

/** Painted fill/stroke values outside `<defs>` (clipPath geometry is never painted). */
function paintedColours(svg: string): string[] {
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/g, '');
  return [...body.matchAll(/\b(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]);
}

function strokeWidths(svg: string): number[] {
  return [...svg.matchAll(/\bstroke-width="([^"]*)"/g)].map((m) => Number(m[1]));
}

const tabFiles = readdirSync(TABS_DIR)
  .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
  .map((f) => path.join(TABS_DIR, f));

describe('ribbon icon design contract', () => {
  it('draws every ribbon button glyph from @/icons, never from lucide-react (#4559)', () => {
    assert.ok(tabFiles.length >= 4, `expected the ribbon tab files under ${TABS_DIR}`);
    const offenders: string[] = [];
    for (const file of tabFiles) {
      const sf = parse(file);
      const imports = importsByModule(sf);
      const house = imports.get('@/icons') ?? new Set<string>();
      for (const { line, icon } of ribbonButtonIcons(sf)) {
        // Extension-contributed buttons receive their icon at runtime
        // (`icon={ext.icon}`); only bare identifiers are static glyph choices.
        if (!/^[A-Za-z_$][\w$]*$/.test(icon)) continue;
        if (!house.has(icon)) {
          const from = [...imports].find(([, names]) => names.has(icon))?.[0] ?? '(local)';
          offenders.push(`${path.relative(SRC, file)}:${line} icon={${icon}} from ${from}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'ribbon button glyphs must come from @/icons — author a house SVG under src/icons/ instead');
  });

  it('every @/icons export resolves to a house SVG on the loader contract', () => {
    const exportsMap = houseIconExports();
    assert.ok(exportsMap.size > 60, `expected the house icon exports in ${ICONS_INDEX}, got ${exportsMap.size}`);
    const problems: string[] = [];
    for (const [name, file] of exportsMap) {
      const svgPath = path.join(ICONS_DIR, `${file}.svg`);
      if (!existsSync(svgPath)) {
        problems.push(`${name}: ${file}.svg is missing`);
        continue;
      }
      const svg = readFileSync(svgPath, 'utf8');
      if (!/<svg[^>]*\bviewBox="0 0 24 24"/.test(svg)) problems.push(`${file}.svg: root must be viewBox="0 0 24 24"`);
      const off = [...new Set(paintedColours(svg).filter((p) => !ALLOWED_PAINTS.has(p)))];
      if (off.length) problems.push(`${file}.svg: paints the loader will not theme: ${off.join(', ')}`);
      const heavy = strokeWidths(svg).filter((w) => !(w <= MAX_STROKE_WIDTH));
      if (heavy.length) problems.push(`${file}.svg: stroke-width ${heavy.join(', ')} exceeds house weight ${MAX_STROKE_WIDTH}`);
    }
    assert.deepEqual(problems, []);
  });

  it('the eight glyphs that used to be lucide are house icons wired to their buttons', () => {
    // Regression pin for #4559: these are the buttons that shipped with
    // lucide glyphs. The generic guard above catches any future one; this
    // names the specific set so a revert of one is reported by name.
    const exportsMap = houseIconExports();
    for (const name of ['Reposition', 'Zones', 'LoadReport', 'Appearance', 'World', 'Move', 'FollowWork', 'ClassicBar']) {
      assert.ok(exportsMap.has(name), `@/icons must export ${name}`);
    }
    const used = new Set<string>();
    for (const file of tabFiles) for (const { icon } of ribbonButtonIcons(parse(file))) used.add(icon);
    for (const name of ['Reposition', 'Zones', 'LoadReport', 'Appearance', 'World', 'Move', 'FollowWork', 'ClassicBar']) {
      assert.ok(used.has(name), `a ribbon button must use icon={${name}}`);
    }
  });
});
