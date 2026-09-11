/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The #4472 regression, pinned at three levels:
 *
 *   1. the CLASSIFIER: the exact shape of PR #4472's production diff -- four
 *      interface members plus JSDoc -- is type-only, and the runtime shapes
 *      that must NOT be (an enum, a class method, a default value) are not;
 *   2. the OBSERVER: with `spawn` injected, a baseline that type-checks and a
 *      revert that puts TS2339 in the changed test file score OBSERVED
 *      through the unmodified `verdict()`; the old runtime answer (4 pass /
 *      4 pass) would have been UNOBSERVED, and a diagnostic that lands only
 *      in some OTHER test file still is;
 *   3. the DISPATCHER, end to end: a throwaway git repo carrying a
 *      #4472-shaped branch, judged by the real `check-test-revert-oracle.mjs`
 *      with the real `tsc`, reports `"observer": "typecheck"` and OBSERVED --
 *      and the same branch with a runtime-only test reports UNOBSERVED, so
 *      the new channel cannot pass vacuously.
 *
 * Run: node --test scripts/lib/revert-oracle-type-only.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { aggregate, verdict } from './revert-oracle.mjs';
import {
  erasedShape,
  isTypeOnlyChange,
  loadTypeScript,
  parseTscDiagnostics,
  runTypecheckPlan,
  typecheckPlans,
  typeOnlyProduction,
} from './revert-oracle-type-only.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const ts = createRequire(import.meta.url)('typescript');

// ---------------------------------------------------------------------------
// 1. The classifier, on the #4472 shape and its runtime neighbours.
// ---------------------------------------------------------------------------

const BASE = `import type { MeshData } from '@ifc-lite/geometry';

export interface SceneContents {
  getMeshes(): MeshData[];
  getMeshDataPieces(expressId: number, modelIndex?: number): MeshData[] | undefined;
  getEntityBoundingBox(expressId: number): { min: number[]; max: number[] } | null;
}
`;

// PR #4472's diff, verbatim in shape: four members and their JSDoc, nothing else.
const HEAD_4472 = `import type { MeshData } from '@ifc-lite/geometry';

export interface SceneContents {
  getMeshes(): MeshData[];
  getMeshDataPieces(expressId: number, modelIndex?: number): MeshData[] | undefined;
  /**
   * The single-mesh accessor: one representative mesh per entity, or
   * \`undefined\` when the entity has no flat mesh data (#4357).
   */
  getMeshData(expressId: number, modelIndex?: number): MeshData | undefined;
  /** Visits every flat mesh piece in the scene (#4357). */
  forEachMeshData(visit: (md: MeshData) => void): void;
  getEntityBoundingBox(expressId: number): { min: number[]; max: number[] } | null;
  /** Row-major 4x4 local-to-world, f64 precision (#4357). */
  getEntityTransform(expressId: number): Float64Array | null;
  /** Bounds in the entity's OWN local frame (#4357). */
  getEntityLocalBounds(
    expressId: number,
  ): { min: [number, number, number]; max: [number, number, number] } | null;
}
`;

test('#4472: four interface members plus JSDoc is a type-only change', () => {
  assert.equal(isTypeOnlyChange(ts, 'packages/renderer/src/scene-contents.ts', BASE, HEAD_4472), true);
  // Anti-vacuity: the erased shape is not empty prose -- it is the one line
  // that survives, and it survives identically on both sides.
  assert.equal(erasedShape(ts, HEAD_4472, 'x.ts'), erasedShape(ts, BASE, 'x.ts'));
  assert.equal(erasedShape(ts, BASE, 'x.ts'), '');
});

test('a type alias, a `declare`, an `import type`, a generic and an annotation all erase', () => {
  const base = 'export function f(a: number) { return a + 1; }\n';
  const head =
    "import type { Foo } from './foo.js';\n" +
    'declare const __brand: unique symbol;\n' +
    'export type Wide<T extends Foo = Foo> = T & { [__brand]: true };\n' +
    'export function f(a: number): number { return a + 1; }\n';
  assert.equal(isTypeOnlyChange(ts, 'src/a.ts', base, head), true);
});

test('a NEW `.d.ts` and a NEW interface-only module are type-only (added file, base is empty)', () => {
  assert.equal(isTypeOnlyChange(ts, 'src/types.d.ts', '', 'export interface X { a: number }\n'), true);
  assert.equal(isTypeOnlyChange(ts, 'src/shapes.ts', '', 'export interface X { a: number }\nexport type Y = X[];\n'), true);
});

test('runtime shapes are NOT type-only: enum member, class method, default value, new statement', () => {
  const cases = [
    ['enum member', 'export enum K { A }\n', 'export enum K { A, B }\n'],
    ['class method', 'export class C {}\n', 'export class C { m(): void {} }\n'],
    ['default value', 'export function f(a: number) { return a; }\n', 'export function f(a: number = 1) { return a; }\n'],
    ['new statement', 'export const a = 1;\n', 'export const a = 1;\nexport const b = 2;\n'],
    ['changed literal', 'export const LIMIT = 5;\n', 'export const LIMIT = 6;\n'],
    ['interface member AND a runtime line', BASE, `${HEAD_4472}export const VERSION = 2;\n`],
  ];
  for (const [name, base, head] of cases) {
    assert.equal(isTypeOnlyChange(ts, 'src/a.ts', base, head), false, name);
  }
});

test('a non-TypeScript path is never type-only, and an unchanged file is not a CHANGE', () => {
  assert.equal(isTypeOnlyChange(ts, 'src/a.mjs', 'export const a = 1;\n', 'export const a = 1; // now with a comment\n'), false);
  assert.equal(isTypeOnlyChange(ts, 'src/a.rs', 'fn a() {}', 'fn a() {}'), false);
  assert.equal(isTypeOnlyChange(ts, 'src/a.ts', BASE, BASE), false);
});

test('a `.tsx` file with an added props type is type-only; JSX is preserved, not lowered', () => {
  const base = 'export function Box(p) { return <div>{p.x}</div>; }\n';
  const head = 'type Props = { x: number };\nexport function Box(p: Props) { return <div>{p.x}</div>; }\n';
  assert.equal(isTypeOnlyChange(ts, 'src/Box.tsx', base, head), true);
  assert.match(erasedShape(ts, head, 'src/Box.tsx'), /<div>/);
});

test('typeOnlyProduction: every production file must be type-only, and no typescript is "cannot decide"', () => {
  const texts = {
    'src/a.ts': [BASE, HEAD_4472],
    'src/b.ts': ['export const n = 1;\n', 'export const n = 2;\n'],
  };
  const show = (side, p) => texts[p][side === 'base' ? 0 : 1];
  assert.equal(typeOnlyProduction(ts, ['src/a.ts'], show).typeOnly, true);
  const mixed = typeOnlyProduction(ts, ['src/a.ts', 'src/b.ts'], show);
  assert.equal(mixed.typeOnly, false);
  assert.match(mixed.reason, /runtime change in src\/b\.ts/);
  assert.equal(typeOnlyProduction(null, ['src/a.ts'], show).typeOnly, false);
  assert.equal(typeOnlyProduction(ts, [], show).typeOnly, false);
});

test('loadTypeScript resolves the repo\'s own compiler from the root, and null elsewhere', () => {
  assert.equal(typeof loadTypeScript(REPO_ROOT)?.transpileModule, 'function');
  assert.equal(loadTypeScript(mkdtempSync(join(tmpdir(), 'oracle-no-ts-'))), null);
});

// ---------------------------------------------------------------------------
// 2. The observer, with spawn injected, judged by the unmodified verdict().
// ---------------------------------------------------------------------------

const TEST_FILE = 'packages/renderer/src/scene-contents-4357.test.ts';
const PLAN = { dir: join(REPO_ROOT, 'packages/renderer'), files: [TEST_FILE], typecheck: true, runner: { family: 'typecheck' } };
const TS2339 = `${TEST_FILE}(35,37): error TS2339: Property 'getMeshData' does not exist on type 'SceneContents'.\n`;
const ELSEWHERE = `packages/renderer/src/other.test.ts(9,3): error TS2339: Property 'getMeshData' does not exist on type 'SceneContents'.\n`;

const fakeSpawn = (status, stdout) => () => ({ status, stdout, stderr: '' });

test('parseTscDiagnostics reads tsc\'s `file(line,col): error TSnnnn:` lines and nothing else', () => {
  const d = parseTscDiagnostics(`typecheck-tests: packages/renderer FAILED (110 test files)\n${TS2339}${ELSEWHERE}some prose\n`);
  assert.equal(d.length, 2);
  assert.deepEqual(d[0], { file: TEST_FILE, line: 35, col: 37, code: 'TS2339', message: "Property 'getMeshData' does not exist on type 'SceneContents'." });
  assert.equal(parseTscDiagnostics('typecheck-tests: packages/renderer OK (110 test files)\n').length, 0);
  // Windows tsc prints backslashes; they are normalised so the changed-file match holds.
  assert.equal(parseTscDiagnostics('packages\\renderer\\src\\x.test.ts(1,1): error TS1: m\n')[0].file, 'packages/renderer/src/x.test.ts');
});

test('#4472 through verdict(): baseline clean, revert puts TS2339 in the changed test -> OBSERVED', () => {
  const baseline = runTypecheckPlan(PLAN, REPO_ROOT, 'baseline', { spawn: fakeSpawn(0, 'typecheck-tests: packages/renderer OK (110 test files)\n') });
  assert.equal(baseline.kind, 'pass');
  assert.deepEqual([baseline.passed, baseline.failed, baseline.total], [1, 0, 1]);

  const reverted = runTypecheckPlan(PLAN, REPO_ROOT, 'reverted', { spawn: fakeSpawn(1, TS2339) });
  assert.equal(reverted.kind, 'assertion-failure');
  assert.deepEqual([reverted.passed, reverted.failed, reverted.total], [0, 1, 1]);
  assert.match(reverted.evidence[0], /TS2339/);

  const v = verdict({ baseline: aggregate([baseline]), reverted: aggregate([reverted]) });
  assert.equal(v.verdict, 'OBSERVED');
  assert.equal(v.exitCode, 0);
});

test('the pre-fix answer, for contrast: the runtime observer saw pass/pass and said UNOBSERVED', () => {
  // This is what the CI job on #4472 printed: `[baseline] ... pass (pass 4,
  // fail 0, total 4)` and `[reverted] ... pass (pass 4, fail 0, total 4)`.
  const pass4 = { kind: 'pass', passed: 4, failed: 0, total: 4, evidence: [] };
  assert.equal(verdict({ baseline: pass4, reverted: pass4 }).verdict, 'UNOBSERVED');
});

test('a diagnostic that lands ONLY in some other test file is UNOBSERVED, with the reason named', () => {
  const baseline = runTypecheckPlan(PLAN, REPO_ROOT, 'baseline', { spawn: fakeSpawn(0, '') });
  const reverted = runTypecheckPlan(PLAN, REPO_ROOT, 'reverted', { spawn: fakeSpawn(1, ELSEWHERE) });
  assert.equal(reverted.kind, 'pass');
  assert.match(reverted.evidence[0], /outside the changed test files/);
  assert.equal(verdict({ baseline: aggregate([baseline]), reverted: aggregate([reverted]) }).verdict, 'UNOBSERVED');
});

test('a baseline that does not type-check is BASELINE-BROKEN, whichever file the diagnostic is in', () => {
  for (const out of [TS2339, ELSEWHERE]) {
    const baseline = runTypecheckPlan(PLAN, REPO_ROOT, 'baseline', { spawn: fakeSpawn(1, out) });
    assert.equal(baseline.kind, 'load-failure');
    assert.match(baseline.evidence[0], /before any revert/);
    const reverted = runTypecheckPlan(PLAN, REPO_ROOT, 'reverted', { spawn: fakeSpawn(1, TS2339) });
    assert.equal(verdict({ baseline: aggregate([baseline]), reverted: aggregate([reverted]) }).verdict, 'BASELINE-BROKEN');
  }
  // A non-zero exit with nothing parseable is broken too, never a pass.
  assert.equal(runTypecheckPlan(PLAN, REPO_ROOT, 'baseline', { spawn: fakeSpawn(2, 'boom') }).kind, 'load-failure');
});

test('a runner that cannot be spawned, or a root without typecheck-tests.mjs, is runner-missing', () => {
  assert.equal(runTypecheckPlan(PLAN, REPO_ROOT, 'baseline', { spawn: () => ({ error: new Error('ENOENT') }) }).kind, 'runner-missing');
  assert.equal(runTypecheckPlan(PLAN, mkdtempSync(join(tmpdir(), 'oracle-no-script-')), 'baseline').kind, 'runner-missing');
});

test('typecheckPlans groups TypeScript tests by package, names non-TypeScript tests as skipped', () => {
  const { plans, skipped, unassigned } = typecheckPlans(
    ['packages/renderer/src/a.test.ts', 'packages/renderer/src/b.test.tsx', 'packages/parser/src/c.test.ts', 'scripts/lib/d.test.mjs'],
    REPO_ROOT,
  );
  assert.deepEqual(plans.map((p) => p.files), [['packages/renderer/src/a.test.ts', 'packages/renderer/src/b.test.tsx'], ['packages/parser/src/c.test.ts']]);
  assert.deepEqual(plans[0].relFiles, ['src/a.test.ts', 'src/b.test.tsx']);
  assert.equal(plans[0].runner.family, 'typecheck');
  assert.deepEqual(skipped, ['scripts/lib/d.test.mjs']);
  assert.deepEqual(unassigned, []);
});

// ---------------------------------------------------------------------------
// 3. End to end through the dispatcher, with the real tsc.
// ---------------------------------------------------------------------------

const oracle = resolve(HERE, '../check-test-revert-oracle.mjs');

/**
 * A throwaway repo with one package, a #4472-shaped branch on top of it, and
 * just enough of this repository (typecheck-tests.mjs, tsconfig.tests.base.json,
 * a node_modules link) for the real type-checker to run.
 */
function runOnce({ testObservesTypes }) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-type-only-'));
  function run(bin, args) {
    const r = spawnSync(bin, args, { cwd: root, encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(r.error, undefined, `${bin}: ${r.error?.message}`);
    assert.equal(r.status, 0, `${bin} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  }
  try {
    run('git', ['init', '-q']);
    // LF in, LF out: a global `core.autocrlf=true` (the Git-for-Windows
    // default) would otherwise make the restored tree read as modified.
    run('git', ['config', 'core.autocrlf', 'false']);
    run('git', ['config', 'user.name', 'Revert oracle fixture']);
    run('git', ['config', 'user.email', 'oracle@example.invalid']);
    // The slice of this repository the typecheck observer needs.
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(REPO_ROOT, 'scripts/typecheck-tests.mjs'), join(root, 'scripts/typecheck-tests.mjs'));
    copyFileSync(join(REPO_ROOT, 'tsconfig.tests.base.json'), join(root, 'tsconfig.tests.base.json'));
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'junction');
    writeFileSync(join(root, 'package.json'), '{ "name": "oracle-type-only-fixture", "private": true }\n');
    writeFileSync(join(root, '.gitignore'), 'node_modules\ntsconfig.tests.json\n');
    // The package: one interface, no runtime.
    mkdirSync(join(root, 'pkg/src'), { recursive: true });
    writeFileSync(join(root, 'pkg/package.json'), '{ "name": "fixture-pkg", "private": true, "scripts": { "test": "tsx --test src/*.test.ts" } }\n');
    writeFileSync(
      join(root, 'pkg/tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', strict: true, types: [], outDir: './dist', rootDir: './src' }, include: ['src/**/*'] }, null, 2),
    );
    writeFileSync(join(root, 'pkg/src/contents.ts'), 'export interface Contents {\n  getMeshes(): number[];\n}\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'base']);
    const base = run('git', ['rev-parse', 'HEAD']).trim();

    // The branch: a type-only production change plus the test that observes it.
    writeFileSync(
      join(root, 'pkg/src/contents.ts'),
      'export interface Contents {\n  getMeshes(): number[];\n  /** One representative mesh per entity (#4357). */\n  getMeshData(expressId: number): number | undefined;\n}\n',
    );
    writeFileSync(
      join(root, 'pkg/src/contents-4357.test.ts'),
      testObservesTypes
        ? "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport type { Contents } from './contents.js';\n\ntest('getMeshData is on Contents', () => {\n  const fn: Contents['getMeshData'] = (expressId: number): number | undefined => (expressId > 0 ? 1 : undefined);\n  assert.equal(typeof fn, 'function');\n});\n"
        : "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport type { Contents } from './contents.js';\n\ntest('getMeshes is on Contents', () => {\n  const fn: Contents['getMeshes'] = () => [1];\n  assert.equal(fn().length, 1);\n});\n",
    );
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'type-only production change plus a test']);

    const r = spawnSync(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json'], {
      encoding: 'utf8',
      timeout: 100_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(r.error, undefined);
    // The tree must be byte-identical afterwards, whatever the verdict.
    assert.equal(run('git', ['status', '--porcelain']).trim(), '');
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const HAVE_TOOLING = existsSync(join(REPO_ROOT, 'node_modules/typescript/bin/tsc')) && existsSync(join(REPO_ROOT, 'node_modules/@types/node'));

test('END TO END (#4472 shape): the dispatcher picks the typecheck observer and reports OBSERVED', { timeout: 120_000, skip: !HAVE_TOOLING && 'typescript / @types/node not installed' }, () => {
  const { status, stdout, stderr } = runOnce({ testObservesTypes: true });
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /observer: typecheck \(all 1 production file\(s\) erase to identical JavaScript\)/);
  assert.match(stdout, /runner: pkg -> node scripts\/typecheck-tests\.mjs/);
  assert.match(stdout, /\[reverted\] pkg \(typecheck\) -> assertion-failure/);
  assert.match(stdout, /TS2339/);
  assert.match(stdout, /✔ OBSERVED/);
  const json = JSON.parse(stdout.slice(stdout.indexOf('\n{')));
  assert.equal(json.verdict, 'OBSERVED');
  assert.equal(json.observer, 'typecheck');
});

test('END TO END, the failing direction: a test that never names the new member is UNOBSERVED', { timeout: 120_000, skip: !HAVE_TOOLING && 'typescript / @types/node not installed' }, () => {
  const { status, stdout, stderr } = runOnce({ testObservesTypes: false });
  assert.equal(status, 1, `${stdout}\n${stderr}`);
  assert.match(stdout, /observer: typecheck/);
  assert.match(stdout, /\[baseline\] pkg \(typecheck\) -> pass/);
  assert.match(stdout, /\[reverted\] pkg \(typecheck\) -> pass/);
  assert.match(stdout, /UNOBSERVED/);
  assert.equal(JSON.parse(stdout.slice(stdout.indexOf('\n{'))).observer, 'typecheck');
});
