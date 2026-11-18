/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sibling-extracted from source-text-assertion-detect.mjs (#10687) to keep that
 * file under its module-size budget; imported there and nowhere else.
 *
 * The detector resolves a call by its rightmost name, so `assert.ok(source…)`
 * used to taint the parameters of any local `ok`, and the flat taint set spread
 * it. Calls into Node's assert are exempt from that by-name step.
 */

import ts from 'typescript';

/** TRUE when `id` roots a call's callee chain: `id.a.b(…)`. */
function rootsACall(id) {
  let n = id;
  while (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) n = n.parent;
  return n !== id && ts.isCallExpression(n.parent) && n.parent.expression === n;
}

const ASSERT_MODULES = new Set(['assert', 'node:assert', 'assert/strict', 'node:assert/strict']);

/**
 * Names bound to Node's assert module and used ONLY as a call namespace: every
 * mention outside the `import` is the root of a callee, as in `assert.ok(…)`.
 * Such a call runs Node's function, so its bare method name says nothing about
 * a local `ok` (`const facts = { ok: … }`, #10687).
 *
 * Only assert: it never turns a function handed to it into one of its own
 * methods, and calls what `throws`/`rejects` receive with no arguments. A
 * general import can (`reg.set('check', check); reg.check(source)`).
 *
 * Any other mention disqualifies the name: a `const assert` that shadows it, a
 * parameter of that name, `assert.ok = check`. The analysis has no scoping, so
 * it cannot tell whether such a call still means the import, and those keep
 * resolving by name.
 */
function assertNamespaces(sourceFile) {
  const imported = new Set();
  for (const st of sourceFile.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier) || !ASSERT_MODULES.has(st.moduleSpecifier.text)) continue;
    const { name, namedBindings } = st.importClause;
    if (name) imported.add(name.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings)) imported.add(namedBindings.name.text);
    if (namedBindings && ts.isNamedImports(namedBindings))
      for (const el of namedBindings.elements) imported.add(el.name.text);
  }
  const disqualified = new Set();
  const visit = (n) => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isIdentifier(n) && imported.has(n.text)) {
      const isName = ts.isPropertyAccessExpression(n.parent) && n.parent.name === n;
      if (!isName && !rootsACall(n)) disqualified.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return new Set([...imported].filter((name) => !disqualified.has(name)));
}

/**
 * A test for one file: TRUE when a callee is a dotted call into Node's assert,
 * `assert.ok(…)` or `assert.strict.equal(…)`, under the rules above.
 */
export function assertCallTest(sourceFile) {
  const namespaces = assertNamespaces(sourceFile);
  return (callee) => {
    if (!ts.isPropertyAccessExpression(callee)) return false;
    let root = callee.expression;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    return ts.isIdentifier(root) && namespaces.has(root.text);
  };
}
