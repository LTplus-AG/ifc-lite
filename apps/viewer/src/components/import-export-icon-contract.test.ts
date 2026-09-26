/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Import/export icon convention (#5822, charter #5613).
 *
 * The viewer's convention: lucide `Upload` = bring a file IN (import),
 * `Download` = write a file OUT (export). Every panel followed it except BCF,
 * whose Import button showed `Download` and whose Export button showed
 * `Upload`. Nothing checked, so the swap shipped.
 *
 * The rule, read from the TypeScript AST (not the file text):
 * for every `<Upload />` / `<Download />` imported from `lucide-react`, take
 * the nearest enclosing interactive element (`Button`, `button`,
 * `DropdownMenuItem`, `DropdownMenuSubTrigger`) and every translation key
 * passed to `t('…')` inside it (its `title` / `aria-label` and its label).
 * A control labelled only as an export must not show `Upload`; one labelled
 * only as an import must not show `Download`.
 *
 * Only the words "import" and "export" in a key classify it. "load", "open"
 * and "download" are deliberately left out: loading files from a remote
 * source (`SourceFolderStep`) is a download, and opening a local file is an
 * upload, so those words do not decide the direction on their own. A control
 * whose keys say both, or neither, is not judged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const INTERACTIVE = new Set(['Button', 'button', 'DropdownMenuItem', 'DropdownMenuSubTrigger']);
const ICONS = new Set(['Upload', 'Download']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (path.extname(full) === '.tsx' && path.extname(path.basename(full, '.tsx')) !== '.test') out.push(full);
  }
  return out;
}

/** Local names bound to `Upload` / `Download` imported from `lucide-react`. */
function lucideIconNames(sf: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (stmt.moduleSpecifier.text !== 'lucide-react') continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (ICONS.has(imported)) names.set(el.name.text, imported);
    }
  }
  return names;
}

function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return tag.getText();
}

function enclosingInteractive(node: ts.Node): ts.JsxElement | null {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isJsxElement(cur) && INTERACTIVE.has(tagName(cur))) return cur;
  }
  return null;
}

function translationKeys(node: ts.Node): string[] {
  const keys: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 't') {
      const first = n.arguments[0];
      if (first && ts.isStringLiteralLike(first)) keys.push(first.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return keys;
}

type Direction = 'import' | 'export' | null;

/** The direction a control's keys name, judged on the words of the key's segments. */
function directionOf(keys: string[]): Direction {
  // camelCase words of every key segment: `exportJsonButton` -> export, json, button.
  const words = new Set(keys.flatMap((k) => k.split('.').flatMap((seg) => seg.split(/(?=[A-Z])/))).map((w) => w.toLowerCase()));
  const isImport = words.has('import');
  const isExport = words.has('export');
  if (isImport === isExport) return null;
  return isImport ? 'import' : 'export';
}

interface IconUse { file: string; line: number; icon: string; keys: string[] }

function iconUses(file: string, text: string): IconUse[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = lucideIconNames(sf);
  if (names.size === 0) return [];
  const uses: IconUse[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(n) && names.has(tagName(n))) {
      const control = enclosingInteractive(n);
      if (control) {
        uses.push({
          file,
          line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
          icon: names.get(tagName(n))!,
          keys: translationKeys(control),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return uses;
}

function violations(uses: IconUse[]): IconUse[] {
  return uses.filter((u) => {
    const dir = directionOf(u.keys);
    return (dir === 'export' && u.icon === 'Upload') || (dir === 'import' && u.icon === 'Download');
  });
}

describe('import/export icon convention (#5822)', () => {
  it('no viewer control shows Upload for an export or Download for an import', () => {
    const uses = sourceFiles(HERE).flatMap((f) => iconUses(path.relative(HERE, f), readFileSync(f, 'utf8')));
    // Guards the scan itself: if nothing is found the rule certifies nothing.
    assert.ok(uses.length >= 20, `expected to find the viewer's import/export controls, found ${uses.length}`);
    assert.ok(uses.some((u) => directionOf(u.keys) === 'import' && u.icon === 'Upload'));
    assert.ok(uses.some((u) => directionOf(u.keys) === 'export' && u.icon === 'Download'));
    const bad = violations(uses).map((u) => `${u.file}:${u.line} <${u.icon}/> labelled ${u.keys.join(', ')}`);
    assert.deepEqual(bad, [], 'import controls use <Upload/>, export controls use <Download/>');
  });

  it('judges a control by its keys and ignores controls that name neither or both directions', () => {
    const tsx = (icon: string, keys: string[]) => `
      import { ${icon} } from 'lucide-react';
      export const C = () => (<Button title={t('${keys[0]}')}><${icon} />{t('${keys[1] ?? keys[0]}')}</Button>);`;
    assert.equal(violations(iconUses('a.tsx', tsx('Upload', ['bcf.panel.exportTitle']))).length, 1);
    assert.equal(violations(iconUses('b.tsx', tsx('Download', ['bcf.panel.importTitle']))).length, 1);
    assert.equal(violations(iconUses('c.tsx', tsx('Upload', ['bcf.panel.importTitle']))).length, 0);
    assert.equal(violations(iconUses('d.tsx', tsx('Download', ['sources.loadButton']))).length, 0);
    assert.equal(violations(iconUses('e.tsx', tsx('Upload', ['x.importTitle', 'x.exportTitle']))).length, 0);
    // An icon outside any interactive control (decorative) is not judged.
    assert.deepEqual(iconUses('f.tsx', `import { Upload } from 'lucide-react';\nexport const C = () => <div><Upload />{t('x.export')}</div>;`), []);
  });
});
