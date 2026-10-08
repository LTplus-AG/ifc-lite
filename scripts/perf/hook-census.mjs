#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Hook census (#6957): how many React hooks and viewer-store subscriptions sit
// on the viewport, properties, hierarchy and streaming paths.
//
//   node scripts/perf/hook-census.mjs [--json] [--top N]
//
// A measurement for perf PRs, not a gate: nothing in CI fails on its numbers.
//
// STATIC, by choice. It walks each path's import graph from an entry module
// and counts hook CALL SITES in the component and hook modules it reaches.
// A runtime fiber walk would count mounted instances instead, but (1) the
// benchmark and every user run React's production build, whose component
// names are minified, so mounted fibers cannot be attributed to a panel; and
// (2) mounted counts move with the model, the open panels and the selection,
// so two runs would not agree. A static count is identical on every machine,
// needs no browser and diffs cleanly between a base and a branch. The cost:
// a hook inside a list row counts once, not once per row. React commits per
// load are measured at runtime instead (`react.commits`, lib/perf/reactCommits.ts).
//
// What is counted, per path:
//   modules                component/hook modules reached (.tsx, or a use*.ts hook module)
//   hooks                  calls to `useXxx(...)` / `React.useXxx(...)`
//   storeSubscriptions     `useViewerStore(selector)` calls (each re-runs its selector per write)
//   wholeStoreSubscriptions `useViewerStore()` with no selector (re-renders on EVERY write)

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isMainEntry } from '../lib/is-main-entry.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const VIEWER_SRC = join(REPO, 'apps/viewer/src');

export const PATHS = {
  viewport: 'components/viewer/ViewportContainer.tsx',
  properties: 'components/viewer/PropertiesPanel.tsx',
  hierarchy: 'components/viewer/HierarchyPanel.tsx',
  streaming: 'components/viewer/useGeometryStreaming.ts',
};

const EXTENSIONS = ['.tsx', '.ts', '/index.tsx', '/index.ts'];

/** Resolve a relative or `@/` specifier to a source file under `srcRoot`, or null. */
function resolveSpecifier(spec, fromFile, srcRoot) {
  let base;
  if (spec.startsWith('@/')) base = join(srcRoot, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec);
  else return null;
  base = base.replace(/\.(js|jsx|ts|tsx)$/, '');
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const isTest = (file) => /\.test\.tsx?$|\/test\//.test(file);
/** Modules whose hook calls run inside a component: components and hook modules. */
const isHookBearing = (file) => file.endsWith('.tsx') || /\/use[A-Z][^/]*\.ts$/.test(file);

/** Hook and subscription counts of one source file, plus its import specifiers. */
export function scanModule(file, text = readFileSync(file, 'utf8')) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const counts = { hooks: 0, storeSubscriptions: 0, wholeStoreSubscriptions: 0 };
  const imports = [];
  const stack = [source];
  while (stack.length > 0) {
    const node = stack.pop();
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly && !node.isTypeOnly) imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        imports.push(node.arguments[0].text); // lazy(() => import('./Panel'))
      }
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'React' ? callee.name.text
          : null;
      if (name && /^use[A-Z0-9]/.test(name)) {
        counts.hooks++;
        if (name === 'useViewerStore') {
          if (node.arguments.length === 0) counts.wholeStoreSubscriptions++;
          else counts.storeSubscriptions++;
        }
      }
    }
    node.forEachChild((child) => { stack.push(child); });
  }
  return { counts, imports };
}

/** Census of the import graph rooted at `entry` (absolute path). */
export function censusFrom(entry, srcRoot = VIEWER_SRC, top = 10) {
  const seen = new Set();
  const queue = [entry];
  const totals = { modules: 0, hooks: 0, storeSubscriptions: 0, wholeStoreSubscriptions: 0 };
  const perModule = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const { counts, imports } = scanModule(file);
    if (isHookBearing(file) || file === entry) {
      totals.modules++;
      totals.hooks += counts.hooks;
      totals.storeSubscriptions += counts.storeSubscriptions;
      totals.wholeStoreSubscriptions += counts.wholeStoreSubscriptions;
      if (counts.hooks > 0) perModule.push({ file: relative(srcRoot, file), ...counts });
    }
    for (const spec of imports) {
      const target = resolveSpecifier(spec, file, srcRoot);
      if (target && !isTest(target) && !seen.has(target)) queue.push(target);
    }
  }
  perModule.sort((a, b) => b.hooks - a.hooks || a.file.localeCompare(b.file));
  return { ...totals, topModules: perModule.slice(0, top) };
}

export function hookCensus(srcRoot = VIEWER_SRC, paths = PATHS, top = 10) {
  return Object.fromEntries(Object.entries(paths).map(([name, entry]) => [name, censusFrom(join(srcRoot, entry), srcRoot, top)]));
}

if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const topArg = args.indexOf('--top');
  // `--top 0` is valid (totals only); only a missing/garbled value is an error.
  const top = topArg >= 0 ? Number(args[topArg + 1]) : 10;
  if (!Number.isInteger(top) || top < 0) {
    console.error(`hook-census: --top expects a non-negative integer, got ${JSON.stringify(args[topArg + 1])}`);
    process.exit(2);
  }
  const census = hookCensus(VIEWER_SRC, PATHS, top);
  if (args.includes('--json')) {
    console.log(JSON.stringify(census, null, 2));
  } else {
    console.log('path        modules  hooks  store subs  whole-store subs');
    for (const [name, c] of Object.entries(census)) {
      console.log(`${name.padEnd(11)} ${String(c.modules).padStart(7)} ${String(c.hooks).padStart(6)} ${String(c.storeSubscriptions).padStart(11)} ${String(c.wholeStoreSubscriptions).padStart(17)}`);
    }
  }
}
