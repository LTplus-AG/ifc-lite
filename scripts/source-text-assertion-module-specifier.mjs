/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sibling-extracted from source-text-assertion-detect.mjs (#3754) to keep that
 * file under its module-size budget; imported there and nowhere else.
 *
 * TRUE when `node` is the module specifier of a static or dynamic import/
 * re-export -- `from './x.mjs'`, `export * from './x.mjs'`, `import('./x.mjs')`
 * -- rather than a string a test wrote to name a file it reads.
 *
 * Needed because #3754 added `mjs` to SOURCE_LITERAL: Node ESM requires the
 * extension on every relative import, so `scripts/**\/*.test.mjs` names its
 * own subject in a `.mjs` import literal on line one, every time. Without this
 * exclusion that import alone satisfied `namesASourceFile` on nearly every
 * file in the tree, and the pairing rule's deliberately over-eager taint
 * propagation (a helper's return value taints its own name; any call to that
 * name then taints its binding, regardless of that call's actual arguments --
 * see `computeTainted` in source-text-assertion-detect.mjs) turned one `.mjs`
 * import into hundreds of unrelated hits on values like a spawned process's
 * `stdout`. `.ts`/`.tsx`/`.mts` never hit this because this repo's TS imports
 * omit the extension, so the same hole was latent there too and this closes it
 * for every extension, not only the new one.
 */
import ts from 'typescript';

export function isModuleSpecifierLiteral(node) {
  const parent = node.parent;
  if (!parent) return false;
  if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node)
    return true;
  if (
    ts.isCallExpression(parent) &&
    parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
    parent.arguments[0] === node
  )
    return true;
  return false;
}
