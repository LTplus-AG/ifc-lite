/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A package's `sideEffects` declaration must cover every source module that
 * may do work at load time (#9200).
 *
 * `"sideEffects": false` tells the bundler it may drop any module whose
 * exports nobody uses, top-level code included. A module that registers
 * something at load (a `setX(...)` call, `const token = register(...)`, a bare
 * `import './x'`, a class static block) is then dropped without a warning,
 * and the registration with it. The viewer bundles @ifc-lite/sdk and
 * @ifc-lite/create from source, so this is a silent behaviour change, not a
 * build error. @ifc-lite/sdk's index wires the parser's schema check into
 * @ifc-lite/mutations that way, which is why its declaration is a list naming
 * that file rather than `false`.
 *
 * The detector is an allowlist, so a form it does not know counts as work:
 *   - allowed top-level statements: imports that bind something, re-exports
 *     and export lists, and type, interface, function, enum and ambient
 *     declarations; `const`/`let`/`var`, classes and `export default` when
 *     their values are inert (below). Everything else is flagged: expression
 *     statements, bare imports, `if`/`for`/`try`/blocks, namespaces, class
 *     static blocks, decorators, `import x = require(...)`.
 *   - an inert value is built from literals, names, property reads, object,
 *     array and untagged template literals, operators other than assignment,
 *     increment and the comma, functions and classes (their bodies run later,
 *     so they are not inspected, apart from a class's static fields),
 *     `new Set|Map|WeakMap|WeakSet(...)` and the few built-ins listed in
 *     PURE_CALLS that read only their arguments. Any other call or `new`,
 *     a tagged template, `await`, `yield` or `delete` is flagged.
 * TypeScript and JavaScript modules under each package's src/ are scanned.
 *
 * Every published package that declares `sideEffects` is checked: a module
 * with possible load-time work must be named by the list (and `false` names
 * none). A false alarm is resolved by moving the work into a function, or,
 * after reading the module, by an entry in REVIEWED_PURE with the reason.
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

const K = ts.SyntaxKind;
const PURE_CONSTRUCTORS = new Set(['Set', 'Map', 'WeakMap', 'WeakSet']);
/** Built-ins that read only their arguments and touch no module-external state. */
const PURE_CALLS = new Set([
  'Object.freeze', 'Object.keys', 'Object.values', 'Object.entries', 'Object.fromEntries',
  'Array.from', 'Array.of', 'Symbol', 'Symbol.for', 'String.fromCharCode', 'Number', 'String', 'BigInt',
  'Math.abs', 'Math.sqrt', 'Math.hypot', 'Math.pow', 'Math.min', 'Math.max', 'Math.round', 'Math.floor', 'Math.ceil',
  'Math.cos', 'Math.sin', 'Math.tan', 'Math.atan2', 'Math.log', 'Math.log2', 'Math.log10', 'Math.trunc', 'Math.sign',
]);
const ASSIGNMENT_OPERATORS = new Set([
  K.EqualsToken, K.PlusEqualsToken, K.MinusEqualsToken, K.AsteriskEqualsToken, K.AsteriskAsteriskEqualsToken,
  K.SlashEqualsToken, K.PercentEqualsToken, K.LessThanLessThanEqualsToken, K.GreaterThanGreaterThanEqualsToken,
  K.GreaterThanGreaterThanGreaterThanEqualsToken, K.AmpersandEqualsToken, K.BarEqualsToken, K.CaretEqualsToken,
  K.AmpersandAmpersandEqualsToken, K.BarBarEqualsToken, K.QuestionQuestionEqualsToken, K.CommaToken,
]);

const hasModifier = (node, kind) => !!node.modifiers?.some((m) => m.kind === kind);
const decorated = (node) => ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;

/** The first reason `node` may do work when evaluated, or null when it is inert. */
function work(node, sf) {
  let reason = null;
  const visit = (n) => {
    if (reason) return;
    // Bodies run when called, not at load.
    if (ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
      || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n)) return;
    if (ts.isClassExpression(n) || ts.isClassDeclaration(n)) { reason = classWork(n, sf); return; }
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (!PURE_CALLS.has(callee)) { reason = `call ${callee}()`; return; }
    } else if (ts.isNewExpression(n)) {
      const callee = n.expression.getText(sf);
      if (!PURE_CONSTRUCTORS.has(callee)) { reason = `new ${callee}`; return; }
    } else if (ts.isTaggedTemplateExpression(n)) { reason = 'tagged template'; return; }
    else if (ts.isAwaitExpression(n)) { reason = 'await'; return; }
    else if (ts.isYieldExpression(n)) { reason = 'yield'; return; }
    else if (ts.isDeleteExpression(n)) { reason = 'delete'; return; }
    else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
      && (n.operator === K.PlusPlusToken || n.operator === K.MinusMinusToken)) { reason = 'increment'; return; }
    else if (ts.isBinaryExpression(n) && ASSIGNMENT_OPERATORS.has(n.operatorToken.kind)) {
      reason = n.operatorToken.kind === K.CommaToken ? 'comma expression' : 'assignment'; return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return reason;
}

/** Load-time work in a class: decorators, static blocks and static field values. */
function classWork(node, sf) {
  if (decorated(node)) return 'decorator';
  if (node.heritageClauses) {
    for (const clause of node.heritageClauses) for (const type of clause.types) {
      const r = work(type.expression, sf);
      if (r) return `${r} in extends`;
    }
  }
  for (const member of node.members) {
    if (decorated(member) || member.parameters?.some?.(decorated)) return 'decorator';
    if (ts.isClassStaticBlockDeclaration(member)) return 'static block';
    if (member.name && ts.isComputedPropertyName(member.name)) {
      const r = work(member.name.expression, sf);
      if (r) return `${r} in a computed member name`;
    }
    if (ts.isPropertyDeclaration(member) && hasModifier(member, K.StaticKeyword) && member.initializer) {
      const r = work(member.initializer, sf);
      if (r) return `${r} in a static field`;
    }
  }
  return null;
}

/** Why a top-level statement may do work at load, or null when it cannot. */
function statementWork(st, sf) {
  if (hasModifier(st, K.DeclareKeyword)) return null; // ambient: emits nothing
  if (ts.isImportDeclaration(st)) return st.importClause ? null : 'bare import';
  if (ts.isExportDeclaration(st)) return null;
  if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isFunctionDeclaration(st)) return null;
  if (ts.isEnumDeclaration(st)) {
    for (const member of st.members) {
      const r = member.initializer && work(member.initializer, sf);
      if (r) return `${r} in an enum member`;
    }
    return null;
  }
  if (ts.isVariableStatement(st)) {
    for (const d of st.declarationList.declarations) {
      const r = d.initializer && work(d.initializer, sf);
      if (r) return r;
    }
    return null;
  }
  if (ts.isClassDeclaration(st)) return classWork(st, sf);
  if (ts.isExportAssignment(st)) return work(st.expression, sf);
  if (ts.isExpressionStatement(st)) return ts.isStringLiteral(st.expression) ? null /* a directive */ : (work(st.expression, sf) ?? 'statement');
  if (ts.isEmptyStatement(st)) return null;
  if (ts.isModuleDeclaration(st)) return 'namespace';
  if (ts.isImportEqualsDeclaration(st)) return st.isTypeOnly ? null : 'import =';
  return ts.SyntaxKind[st.kind].replace(/Statement$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() || 'statement';
}

/** Top-level statements that may run work when the module loads. */
export function topLevelEffects(fileName, source) {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const effects = [];
  for (const st of sf.statements) {
    const reason = statementWork(st, sf);
    if (reason) effects.push(`${reason} at line ${sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1}`);
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
    .filter((f) => /\.(tsx?|[cm]?js)$/.test(f) && !f.endsWith('.d.ts'))
    .filter((f) => !/\.(test|spec|bench)\.(tsx?|[cm]?js)$|\/__tests?__\//.test(f));
}

/**
 * Modules the detector flags whose top-level work was read and found to be
 * pure: it builds a module-local constant from local helpers or built-ins and
 * writes nothing outside the module. Each entry must still be flagged (a stale
 * entry fails), so the list only shrinks. Re-read the file before adding one.
 */
const REVIEWED_PURE = new Map([
  ['packages/ai/src/request-digest.ts', 'a module-local TextEncoder'],
  ['packages/create/src/in-store/wall-join-mesh.oracle.ts', 'test-only oracle (only *.test.ts import it); a normalised ray constant'],
  ['packages/ids-agent/src/sandbox/handles.ts', 'a module-local RegExp'],
  ['packages/ids-agent/src/tools/act-tools.ts', 'defineTool/objectSchema return plain objects; nothing is registered'],
  ['packages/ids-agent/src/tools/ask-user.ts', 'defineTool returns a plain object; nothing is registered'],
  ['packages/ids-agent/src/tools/bsdd-tools.ts', 'defineTool returns a plain object; nothing is registered'],
  ['packages/ids-agent/src/tools/ids-read.ts', 'defineTool returns a plain object; nothing is registered'],
  ['packages/ids-agent/src/tools/model-tools.ts', 'defineTool returns a plain object; nothing is registered'],
  ['packages/ids-agent/src/tools/schema-tools.ts', 'defineTool returns a plain object; nothing is registered'],
  ['packages/ids-authoring/src/bsdd/mapping.ts', 'maps a literal unit list into a constant'],
  ['packages/ids-authoring/src/document/fields.ts', 'flattens a local constant'],
  ['packages/ids-authoring/src/gate/context.ts', 'maps a local constant'],
  ['packages/ids-authoring/src/lint/precision.ts', 'filters a local constant'],
  ['packages/ids-authoring/src/ops/schema-values.ts', 'JSON Schema built by local obj()/ref() helpers'],
  ['packages/ids-authoring/src/ops/schema.ts', 'JSON Schema built by local obj()/ref()/buildDefs() helpers'],
  ['packages/ids-authoring/src/revision/sha256.ts', 'a module-local Uint32Array round-constant table'],
  ['packages/ids-authoring/src/sidecar/idsz.ts', 'a fixed Date constant'],
  ['packages/ids-authoring/src/sidecar/sidecar-schema.ts', 'JSON Schema built by a local object() helper'],
  ['packages/ifcx/src/canonical.ts', 'a module-local TextEncoder'],
  ['packages/ifcx/src/types.ts', 'type tables derived from local constants'],
  ['packages/ifcx/src/writer-entities.ts', 'fills a module-local Map from the schema tables'],
  ['packages/source-buildagil/src/scan.ts', 'a query string built from a local constant'],
]);

const flags = (source, file = 'x.ts') => topLevelEffects(file, source);

test('inert module shapes are not flagged', () => {
  assert.deepEqual(flags([
    "'use strict';",
    "import { a } from './a.js';",
    "import type { B } from './b.js';",
    "export { c } from './c.js';",
    "export * from './d.js';",
    'export type T = string;',
    'export interface I { x: number }',
    'export enum E { A = 1, B = A << 1 }',
    'export function f() { register(1); }',
    'export const table = new Map([[1, 2]]);',
    'const ids = Object.freeze({ a: 1, b: [2, `t${3}`] });',
    'export const n = -1, s = cond ? a.b : null, g = () => register(2);',
    'class C { static x = 1; static y = new Set(); m() { register(3); } }',
    'export default function main() { register(4); }',
    'export { a as default };',
    'declare global { interface Window { x: number } }',
    'const R = Math.hypot(1, 2);',
  ].join('\n')), []);
});

test('every load-time form the first detector missed is flagged (#9200 review)', () => {
  const cases = {
    'register(a);': 'call register() at line 1',
    "import './polyfill.js';": 'bare import at line 1',
    'class C { static { init(); } }': 'static block at line 1',
    'const _reg = registerX(1);': 'call registerX() at line 1',
    'export const _reg = registerX(1);': 'call registerX() at line 1',
    'export default registerX(1);': 'call registerX() at line 1',
    'if (ok) registerX(1);': 'if at line 1',
    'try { registerX(1); } catch {}': 'try at line 1',
    'for (const x of xs) registerX(x);': 'for of at line 1',
    '{ registerX(1); }': 'block at line 1',
    'class Z { static x = registerX(1); }': 'call registerX() in a static field at line 1',
    'namespace N { registerX(1); }': 'namespace at line 1',
    'const y = (registerX(1), 2);': 'comma expression at line 1',
    'const y = (a, b);': 'comma expression at line 1',
    '@register class D {}': 'decorator at line 1',
    'class D { @field x = 1; }': 'decorator at line 1',
    'const t = gql`query`;': 'tagged template at line 1',
    'const v = await load();': 'await at line 1',
    'const w = await ready;': 'await at line 1',
    'const o = new Registry();': 'new Registry at line 1',
    'const k = (counter = 1);': 'assignment at line 1',
    'const i = counter++;': 'increment at line 1',
    'const { a } = registerX();': 'call registerX() at line 1',
    'const f = (() => registerX())();': 'call (() => registerX())() at line 1',
    'class W extends mixin(Base) {}': 'call mixin() in extends at line 1',
    'enum E { A = compute() }': 'call compute() in an enum member at line 1',
    'import fs = require("fs");': 'import = at line 1',
  };
  for (const [source, expected] of Object.entries(cases)) assert.deepEqual(flags(source), [expected], source);
});

test('JavaScript modules are parsed and checked too', () => {
  assert.deepEqual(flags('globalThis.registry = new Map();\nexport const x = 1;', 'x.mjs'), ['assignment at line 1']);
  assert.deepEqual(flags('export const ok = 1;', 'x.js'), []);
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
  assert.ok(declaredEffectful(sdk, 'dist/index.js'), 'published consumers bundle dist, which needs the same entry');
});

test('every module with possible load-time work is named by its package sideEffects', () => {
  const problems = [];
  const reviewedStillFlagged = new Set();
  let checked = 0;
  for (const { dir, pkg } of declaringPackages()) {
    for (const file of sourceModules(dir)) {
      checked++;
      const effects = topLevelEffects(file, readFileSync(join(ROOT, file), 'utf8'));
      if (!effects.length || declaredEffectful(pkg.sideEffects, relative(dir, file))) continue;
      if (REVIEWED_PURE.has(file)) { reviewedStillFlagged.add(file); continue; }
      problems.push(`${file} (${pkg.name}): ${effects.join(', ')}`);
    }
  }
  assert.ok(checked > 300, `expected the sdk and create sources at least, checked ${checked}`);
  assert.deepEqual(problems, [], 'name these files in sideEffects, or move the load-time work into a function');
  assert.deepEqual([...REVIEWED_PURE.keys()].filter((file) => !reviewedStillFlagged.has(file)), [],
    'these reviewed entries are no longer flagged; delete them from REVIEWED_PURE');
});
