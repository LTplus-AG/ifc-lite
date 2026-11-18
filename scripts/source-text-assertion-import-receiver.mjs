/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sibling-extracted from source-text-assertion-detect.mjs to keep that file
 * under its module-size budget; imported there and nowhere else.
 *
 * TRUE when `callee` is a method of an imported module: `assert.ok`,
 * `assert.equal`, `path.join`. That function is defined in another file, so
 * the call lands in none of this file's parameters. Resolving it by method
 * name reached any local `ok`, `equal` or `match` instead, and the flat taint
 * set spread that to every same-named parameter in the file (#10595).
 *
 * A receiver that ANY local declaration also binds is not trusted: with no
 * scoping, `const assert = { ok: (text) => … }` inside a test would otherwise
 * shadow the import and go quiet. Over-eager stays the direction.
 */
import ts from 'typescript';

const receiversByFile = new WeakMap();

const DECLARES = (p) =>
  ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) ||
  ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassLike(p);

/** Import-bound names that no other declaration in the file rebinds. */
function importReceivers(sourceFile) {
  const imported = new Set();
  const declared = new Set();
  const visit = (n) => {
    if (ts.isIdentifier(n) && n.parent && n.parent.name === n) {
      if (ts.isImportClause(n.parent) || ts.isNamespaceImport(n.parent) || ts.isImportSpecifier(n.parent))
        imported.add(n.text);
      else if (DECLARES(n.parent)) declared.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  for (const name of declared) imported.delete(name);
  return imported;
}

export function callsImportedModule(callee) {
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  const sourceFile = callee.getSourceFile();
  if (!receiversByFile.has(sourceFile)) receiversByFile.set(sourceFile, importReceivers(sourceFile));
  return receiversByFile.get(sourceFile).has(callee.expression.text);
}
