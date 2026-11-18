/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sibling-extracted from source-text-assertion-detect.mjs to keep that file
 * under its module-size budget; imported there and nowhere else.
 *
 * TRUE when `callee` is a method of an imported `assert` or `path`: `assert.ok`,
 * `assert.strict.equal`, `path.posix.join`. That function is defined in Node,
 * so the call lands in none of this file's parameters. Resolving it by method
 * name reached any local `ok`, `equal` or `match` instead, and the flat taint
 * set spread that to every same-named parameter in the file (#10595).
 *
 * Trust is narrow on purpose (CodeRabbit and /code-review on #10667):
 * - Only the `assert` and `path` families. Neither keeps a caller's function
 *   to call later through another member; `assert.throws(fn, validate)` does
 *   call `validate` with the thrown value, which main does not follow either.
 *   An emitter does keep it
 *   (`process.on('m', emit)`, then `process.emit('m', source)`), and no rule
 *   over the spellings of the listener held, so other modules are not trusted.
 *   Neither is a relative or package import, which is code that can hold a
 *   function of this file.
 * - A family shares one object (`assert.strict` is `assert/strict`), so its
 *   bindings lose trust together.
 * - Never when a declaration rebinds the name: with no scoping,
 *   `const assert = { ok: (text) => … }` inside a test would shadow the import.
 * - Never when the import escapes: aliased, passed, exported, or written
 *   through (`assert.ok = check`). Only calls (`x(…)`, `x.m(…)`, `x.a.m(…)`)
 *   and type positions keep it trusted; no list of escape shapes is complete.
 * - Never when the file loads a module other than by import: `require`,
 *   `createRequire` or `import(…)` can reach the family's object
 *   (`require('node:as' + 'sert').ok = check`), and a computed specifier
 *   cannot be matched, so any of them drops trust for every family.
 * Over-eager stays the direction.
 */
import ts from 'typescript';

/** `assert`, `assert/strict`, `path`, `path/posix`, …, with or without `node:`, as its family. */
const TRUSTED_FAMILY = /^(?:node:)?(assert|path)(?:\/(?:strict|posix|win32))?$/;

const receiversByFile = new WeakMap();

/** TRUE when `n` is a key (`a.assert`, `{ assert: 1 }`, `{ assert: a } = …`), not a use of a binding. */
function isKey(n) {
  const p = n.parent;
  if (ts.isBindingElement(p)) return p.propertyName === n;
  if (ts.isQualifiedName(p)) return p.right === n;
  return p.name === n && (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) ||
    ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isAccessor(p) ||
    ts.isEnumMember(p) || ts.isJsxAttribute(p));
}

/** TRUE for a use that cannot put a local function behind a member: a call through it, or a type. */
function isTrustedUse(id) {
  let e = id;
  while (ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e) e = e.parent;
  if (ts.isCallExpression(e.parent) && e.parent.expression === e) return true;
  for (let p = id.parent; p && !ts.isStatement(p); p = p.parent) if (ts.isTypeNode(p)) return true;
  return false;
}

/** The identifier a member chain starts from: `path` for `path.posix.join`, else null. */
function chainRoot(expr) {
  let root = expr;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  return ts.isIdentifier(root) ? root : null;
}

/** Names bound by an `assert` or `path` import that the file never rebinds or lets escape, and only calls through. */
function importReceivers(sourceFile) {
  const imported = new Map(); // local name -> family
  for (const stmt of sourceFile.statements) {
    const family = ts.isImportDeclaration(stmt) && TRUSTED_FAMILY.exec(stmt.moduleSpecifier.text)?.[1];
    if (family) for (const n of importedNames(stmt)) imported.set(n, family);
  }
  const untrusted = new Set(); // families
  let loadsModules = false;
  const visit = (n) => {
    if (ts.isImportDeclaration(n)) return;
    if ((ts.isIdentifier(n) && (n.text === 'require' || n.text === 'createRequire')) ||
      (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)) loadsModules = true;
    if (ts.isIdentifier(n) && imported.has(n.text) && n.parent && !isTrustedUse(n) && !isKey(n))
      untrusted.add(imported.get(n.text));
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  if (loadsModules) return new Set();
  return new Set([...imported].filter(([, family]) => !untrusted.has(family)).map(([name]) => name));
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
  // Down the chain to its root, as `isTrustedUse` walks up it: `assert.strict.equal` and `path.posix.join` too.
  const root = ts.isPropertyAccessExpression(callee) && chainRoot(callee.expression);
  if (!root) return false;
  const sourceFile = callee.getSourceFile();
  if (!receiversByFile.has(sourceFile)) receiversByFile.set(sourceFile, importReceivers(sourceFile));
  return receiversByFile.get(sourceFile).has(root.text);
}
