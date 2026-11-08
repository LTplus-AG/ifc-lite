/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A package's `sideEffects` declaration must cover every source module that
 * does work at load time (#9200).
 *
 * `"sideEffects": false` tells the bundler it may drop any module whose
 * exports nobody uses, top-level statements included. A module that registers
 * something at load (a `setX(...)` call, a bare `import './x'`, a class static
 * block) is then dropped without a warning, and the registration with it. The
 * viewer bundles @ifc-lite/sdk and @ifc-lite/create from source, so this is a
 * silent behaviour change, not a build error. @ifc-lite/sdk's index wires the
 * parser's schema check into @ifc-lite/mutations that way, which is why its
 * declaration is a list naming that file rather than `false`.
 *
 * Every published package that declares `sideEffects` is checked: a module
 * with a top-level effect must be named by the list (and `false` names none).
 *
 * Run: node --test scripts/package-side-effects.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(import.meta.url)(join(ROOT, 'node_modules', 'typescript'));

/** Top-level statements that run work when the module loads. */
export function topLevelEffects(fileName, source) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const effects = [];
  for (const st of sf.statements) {
    let kind = null;
    if (ts.isExpressionStatement(st) && !ts.isStringLiteral(st.expression)) kind = 'statement';
    else if (ts.isImportDeclaration(st) && !st.importClause) kind = 'bare import';
    else if (ts.isClassDeclaration(st) && st.members.some(ts.isClassStaticBlockDeclaration)) kind = 'static block';
    if (kind) effects.push(`${kind} at line ${sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1}`);
  }
  return effects;
}

/** Whether a `sideEffects` value keeps the module at `relPath` (relative to the package). */
export function declaredEffectful(sideEffects, relPath) {
  if (sideEffects === false) return false;
  if (!Array.isArray(sideEffects)) throw new Error(`unsupported sideEffects value ${JSON.stringify(sideEffects)}`);
  return sideEffects.some((entry) => {
    // @source-text-assertion-ok refuses a sideEffects glob read from package.json JSON, not source text
    if (/[*?{[]/.test(entry)) throw new Error(`glob ${entry} is not supported by this check; name the file`);
    return entry.replace(/^\.\//, '') === relPath;
  });
}

function declaringPackages() {
  const manifests = execFileSync('git', ['ls-files', 'packages/*/package.json'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  return manifests
    .map((m) => ({ dir: dirname(m), pkg: JSON.parse(readFileSync(join(ROOT, m), 'utf8')) }))
    .filter(({ pkg }) => pkg.sideEffects !== undefined && !pkg.private);
}

function sourceModules(dir) {
  return execFileSync('git', ['ls-files', `${dir}/src`], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
    .filter((f) => !/\.(test|spec|bench)\.tsx?$|\/__tests?__\//.test(f));
}

test('the detector flags load-time work and nothing else', () => {
  const effects = topLevelEffects('x.ts', [
    "'use strict';",
    "import { a } from './a.js';",
    "import type { B } from './b.js';",
    "import './polyfill.js';",
    'export const table = new Map([[1, 2]]);',
    'export function f() { register(1); }',
    'register(a);',
    'class C { static { init(); } }',
    'class D { static x = 1; }',
  ].join('\n'));
  assert.deepEqual(effects, ['bare import at line 4', 'statement at line 7', 'static block at line 8']);
});

test('declaredEffectful reads false and file lists, and refuses globs', () => {
  assert.equal(declaredEffectful(false, 'src/index.ts'), false);
  assert.equal(declaredEffectful(['./src/index.ts', './dist/index.js'], 'src/index.ts'), true);
  assert.equal(declaredEffectful(['./src/index.ts'], 'src/other.ts'), false);
  assert.throws(() => declaredEffectful(['**/*.css'], 'src/index.ts'), /not supported/);
});

test('@ifc-lite/create and @ifc-lite/sdk declare sideEffects (#9200)', () => {
  const byName = new Map(declaringPackages().map(({ pkg }) => [pkg.name, pkg]));
  // Without a declaration the viewer's eager code keeps every module a barrel
  // re-exports, so planners only lazy code uses still land on the boot path.
  assert.equal(byName.get('@ifc-lite/create')?.sideEffects, false);
  const sdk = byName.get('@ifc-lite/sdk')?.sideEffects;
  assert.ok(Array.isArray(sdk), '@ifc-lite/sdk must list its effectful modules');
  assert.ok(declaredEffectful(sdk, 'src/index.ts'), 'the sdk index registers the schema normalizer at load');
  // @source-text-assertion-ok asserts the package.json declaration this test is about, not source text
  assert.ok(sdk.includes('./dist/index.js'), 'published consumers bundle dist, which needs the same entry');
});

test('every module with a top-level effect is named by its package sideEffects', () => {
  const problems = [];
  let checked = 0;
  for (const { dir, pkg } of declaringPackages()) {
    for (const file of sourceModules(dir)) {
      checked++;
      const effects = topLevelEffects(file, readFileSync(join(ROOT, file), 'utf8'));
      if (effects.length && !declaredEffectful(pkg.sideEffects, relative(dir, file))) {
        problems.push(`${file} (${pkg.name}): ${effects.join(', ')}`);
      }
    }
  }
  assert.ok(checked > 300, `expected the sdk and create sources at least, checked ${checked}`);
  assert.deepEqual(problems, [], 'list these files in sideEffects, or move the load-time work into a function');
});
