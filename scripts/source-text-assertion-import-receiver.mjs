/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sibling-extracted from source-text-assertion-detect.mjs to keep that file
 * under its module-size budget; imported there and nowhere else.
 *
 * TRUE when `callee` is a method of an imported Node builtin: `assert.ok`,
 * `assert.equal`, `path.join`. That function is defined in Node, so the call
 * lands in none of this file's parameters. Resolving it by method name reached
 * any local `ok`, `equal` or `match` instead, and the flat taint set spread
 * that to every same-named parameter in the file (#10595).
 *
 * Trust is narrow on purpose (CodeRabbit and /code-review on #10667):
 * - Builtins only. A relative or package import is code that can hold, or
 *   be handed through `hooks.register(check)`, a function of this file.
 * - Never when a declaration rebinds the name: with no scoping,
 *   `const assert = { ok: (text) => … }` inside a test would shadow the import.
 * - Never when the import escapes: aliased, passed, spread, or written through
 *   (`path.join = check`). Only calls (`x(…)`, `x.m(…)`, `x.a.m(…)`) and type
 *   positions keep it trusted; no list of escape shapes is complete.
 * Over-eager stays the direction.
 */
import { isBuiltin } from 'node:module';
import ts from 'typescript';

const receiversByFile = new WeakMap();

const DECLARES = (p) =>
  ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) ||
  ts.isFunctionExpression(p) || ts.isClassLike(p) || ts.isModuleDeclaration(p) || ts.isImportEqualsDeclaration(p);

/** TRUE for a use that cannot put a local function behind a member: a call through it, or a type. */
function isTrustedUse(id) {
  let e = id;
  while (ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e) e = e.parent;
  if (ts.isCallExpression(e.parent) && e.parent.expression === e) return true;
  for (let p = id.parent; p && !ts.isStatement(p); p = p.parent) if (ts.isTypeNode(p)) return true;
  return false;
}

/** Names bound by a builtin import that the file never rebinds and only calls through. */
function importReceivers(sourceFile) {
  const imported = new Set();
  for (const stmt of sourceFile.statements)
    if (ts.isImportDeclaration(stmt) && isBuiltin(stmt.moduleSpecifier.text)) for (const n of importedNames(stmt)) imported.add(n);
  const untrusted = new Set();
  const visit = (n) => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isIdentifier(n) && imported.has(n.text) && n.parent && !isTrustedUse(n)) {
      const p = n.parent;
      // A key (`a.assert`, `{ assert: 1 }`, `{ assert: a } = …`) is not a use; a declaration or any other use is.
      const isKey = (p.name === n && !DECLARES(p) && !ts.isShorthandPropertyAssignment(p)) ||
        (ts.isBindingElement(p) && p.propertyName === n);
      if (!isKey) untrusted.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  for (const name of untrusted) imported.delete(name);
  return imported;
}

function importedNames(decl) {
  const clause = decl.importClause;
  if (!clause) return [];
  const names = clause.name ? [clause.name.text] : [];
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
  if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) names.push(el.name.text);
  return names;
}

export function callsImportedModule(callee) {
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  const sourceFile = callee.getSourceFile();
  if (!receiversByFile.has(sourceFile)) receiversByFile.set(sourceFile, importReceivers(sourceFile));
  return receiversByFile.get(sourceFile).has(callee.expression.text);
}
