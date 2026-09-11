/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The TYPECHECK observer for the revert oracle (#4472).
 *
 * WHAT WENT WRONG. `check-test-revert-oracle.mjs` asks "do the branch's
 * changed tests go red when its production change is reverted?", and it
 * answers by RUNNING the tests. PR #4472 added four members to the
 * `SceneContents` interface and a test file whose whole point is compile-time:
 * `const fn: SceneContents['getMeshData'] = ...`. Reverting the interface makes
 * `tsc` report TS2339 at that line -- and changes nothing at runtime, because
 * an interface member has no runtime. `tsx --test` transpiles without checking,
 * so the oracle saw 4 pass / 4 pass and reported UNOBSERVED. The change WAS
 * observed; the oracle was listening on the wrong channel.
 *
 * WHAT THIS DOES. Two pure decisions plus one runner, all injectable so the
 * verdict path is testable without git or tsc:
 *
 *   1. `isTypeOnlyChange(ts, path, baseText, headText)`: a TypeScript file
 *      whose base and head TRANSPILE to the same JavaScript (comments
 *      stripped, whitespace collapsed) changed only its types. Interfaces,
 *      type aliases, `declare`, `import type`, annotations, generics -- all
 *      of it erases. An `enum`, a class member, a default value, a new
 *      statement -- none of it does, and such a file is NOT type-only, so the
 *      ordinary runtime observer still runs for it.
 *   2. `typeOnlyProduction(ts, paths, show)`: the branch is a type-only branch
 *      when EVERY production file is TypeScript and type-only. One runtime
 *      change anywhere and the runtime observer is the right one for the
 *      whole revert set (a mixed revert is judged by the stricter tool).
 *   3. `typecheckPlans` / `runTypecheckPlan`: group the changed TypeScript
 *      test files by owning package and type-check that package's test
 *      program through `scripts/typecheck-tests.mjs` (the repo's dedicated
 *      lane for test-only type errors, #2457), at baseline and again with
 *      production reverted. The result carries the SAME shape
 *      `parseRunnerOutput` produces, so `aggregate()` and `verdict()` in
 *      revert-oracle.mjs judge it unchanged:
 *
 *        baseline    exit 0                       -> pass          (required)
 *        baseline    any diagnostic               -> load-failure  -> BASELINE-BROKEN
 *        reverted    >= 1 diagnostic IN A CHANGED
 *                    TEST FILE                    -> assertion-failure -> OBSERVED
 *        reverted    diagnostics elsewhere only,
 *                    or none                      -> pass          -> UNOBSERVED
 *
 *      "In a changed test file" is the whole rule. A diagnostic somewhere
 *      else says the revert broke an OLD test's types, which is a fact about
 *      the old test, not evidence that this branch's test observes this
 *      branch's change -- the same wrong-reason-red the runtime observer
 *      refuses to count.
 *
 * FAILS CLOSED. No `typescript` resolvable from the repo root, no
 * `typecheck-tests.mjs`, a package without a `tsconfig.json`, a test file that
 * is not TypeScript -- each is reported by name, never silently treated as a
 * pass. The dispatcher reports `observer: "typecheck"` in `--json` so a reader
 * of the verdict knows which channel it came from.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'];

export const TYPECHECK_SCRIPT = 'scripts/typecheck-tests.mjs';

/** `.ts` / `.tsx` / `.mts` / `.cts`, including `.d.ts`. */
export function isTypeScriptPath(path) {
  return TS_EXTS.some((ext) => path.endsWith(ext));
}

/**
 * The repo's own `typescript`, resolved from `root` so the oracle judges with
 * the compiler the branch builds with. `null` when it is not installed --
 * callers must treat that as "cannot decide", never as "not type-only".
 */
export function loadTypeScript(root) {
  try {
    const req = createRequire(pathToFileURL(join(root, 'package.json')));
    return req('typescript');
  } catch {
    return null;
  }
}

/**
 * The JavaScript a TypeScript source erases to, normalised for comparison.
 *
 * `removeComments` so a JSDoc paragraph (the #4472 diff carried four) cannot
 * make two type-identical files differ; whitespace collapsed so a reflowed
 * line cannot either. ESNext/ESNext keeps the output closest to the source
 * (no downlevel helpers that would differ on unrelated grounds); `jsx:
 * preserve` so a `.tsx` file is not rewritten through React.createElement.
 */
export function erasedShape(ts, text, fileName) {
  const out = ts.transpileModule(text, {
    fileName,
    reportDiagnostics: false,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      removeComments: true,
      sourceMap: false,
      inlineSourceMap: false,
      declaration: false,
    },
  });
  // A module left with only type exports emits a bare `export {};` marker; a
  // file with no statements at all is treated as a script and emits only the
  // `"use strict";` prologue. Both mean "no runtime", so both are dropped
  // before comparing -- an ADDED interface-only file ('' at base) is type-only.
  return out.outputText
    .replace(/^\s*"use strict";/, '')
    .replace(/\bexport \{\};/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True only when `path` is TypeScript and its base and head erase to the same
 * JavaScript. An added or deleted file passes `''` for the missing side, so a
 * new `.d.ts` or a new interface-only module is type-only too.
 *
 * @param {object} ts the `typescript` module
 * @param {string} path repo-relative path
 * @param {string} baseText contents at base ('' when the file did not exist)
 * @param {string} headText contents at head ('' when the file was deleted)
 */
export function isTypeOnlyChange(ts, path, baseText, headText) {
  if (!isTypeScriptPath(path)) return false;
  if (baseText === headText) return false; // nothing changed: not a type-only CHANGE
  // A declaration file has no runtime by definition (and transpileModule
  // refuses to emit one), so any change to it is type-only.
  if (/\.d\.[cm]?ts$/.test(path)) return true;
  return erasedShape(ts, baseText, path) === erasedShape(ts, headText, path);
}

/**
 * Is the whole production side of this branch type-only?
 *
 * @param {object|null} ts the `typescript` module, or null when unresolvable
 * @param {string[]} paths every production path in the diff
 * @param {(side: 'base'|'head', path: string) => string} show file contents
 *   at that side ('' when absent)
 * @returns {{typeOnly: boolean, reason: string}}
 */
export function typeOnlyProduction(ts, paths, show) {
  if (paths.length === 0) return { typeOnly: false, reason: 'no production files' };
  if (!ts) return { typeOnly: false, reason: 'typescript is not resolvable from the repo root' };
  const runtime = paths.filter((p) => !isTypeOnlyChange(ts, p, show('base', p), show('head', p)));
  if (runtime.length > 0) {
    return { typeOnly: false, reason: `runtime change in ${runtime[0]}${runtime.length > 1 ? ` (+${runtime.length - 1} more)` : ''}` };
  }
  return { typeOnly: true, reason: `all ${paths.length} production file(s) erase to identical JavaScript` };
}

function findUp(startDir, filename, root) {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, filename))) return dir;
    const parent = dirname(dir);
    if (parent === dir || !parent.startsWith(root)) return null;
    dir = parent;
  }
}

/**
 * One plan per package that owns a changed TypeScript test file. Non-TypeScript
 * test files can never observe a type-only change and are listed in `skipped`
 * by name so the dispatcher can say so.
 *
 * The plan carries the same fields as `planRuns()`'s so `runPlan` can print
 * it the same way; `runner.family` is `typecheck` and `runner.args` names the
 * script that will be spawned, for the log line.
 */
export function typecheckPlans(testPaths, root) {
  const groups = new Map();
  const skipped = [];
  const unassigned = [];
  for (const rel of testPaths) {
    if (!isTypeScriptPath(rel)) { skipped.push(rel); continue; }
    const abs = join(root, rel);
    const pkgDir = findUp(dirname(abs), 'package.json', root);
    if (!pkgDir || pkgDir === root || !existsSync(join(pkgDir, 'tsconfig.json'))) { unassigned.push(rel); continue; }
    if (!groups.has(pkgDir)) groups.set(pkgDir, { dir: pkgDir, files: [] });
    groups.get(pkgDir).files.push(rel);
  }
  const plans = [...groups.values()].map((g) => ({
    key: `typecheck:${g.dir}`,
    dir: g.dir,
    files: g.files,
    relFiles: g.files.map((f) => relative(g.dir, join(root, f)).split(sep).join('/')),
    script: undefined,
    crate: null,
    typecheck: true,
    runner: { family: 'typecheck', bin: 'node', args: [TYPECHECK_SCRIPT] },
  }));
  return { plans, skipped, unassigned };
}

/**
 * `path(line,col): error TSnnnn: message` lines, as tsc prints them (relative
 * to its cwd -- the repo root, the way typecheck-tests.mjs spawns it).
 */
export function parseTscDiagnostics(text) {
  const out = [];
  const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ file: m[1].split('\\').join('/'), line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] });
  }
  return out;
}

const samePath = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/**
 * Type-check one package's test program and score it like a test run.
 *
 * @param {object} plan from `typecheckPlans`
 * @param {string} root repo root (where `scripts/typecheck-tests.mjs` lives)
 * @param {'baseline'|'reverted'} phase which run this is -- see the header table
 * @param {{spawn?: typeof spawnSync}} [deps] injectable for tests
 */
export function runTypecheckPlan(plan, root, phase, { spawn = spawnSync } = {}) {
  const script = join(root, TYPECHECK_SCRIPT);
  if (!existsSync(script)) {
    return { kind: 'runner-missing', passed: null, failed: null, total: null, evidence: [`${TYPECHECK_SCRIPT} not found under ${root}`] };
  }
  const r = spawn(process.execPath, [script], {
    cwd: plan.dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  if (r.error) {
    return { kind: 'runner-missing', passed: null, failed: null, total: null, evidence: [`could not spawn ${TYPECHECK_SCRIPT}: ${r.error.message}`] };
  }
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const diagnostics = parseTscDiagnostics(output);
  const total = plan.files.length;
  const inChanged = diagnostics.filter((d) => plan.files.some((f) => samePath(d.file, f)));
  const elsewhere = diagnostics.length - inChanged.length;
  const describe = (d) => `${d.file}(${d.line},${d.col}): ${d.code} ${d.message}`;

  if (phase === 'baseline') {
    if (r.status === 0 && diagnostics.length === 0) {
      return { kind: 'pass', passed: total, failed: 0, total, evidence: [] };
    }
    return {
      kind: 'load-failure',
      passed: null,
      failed: null,
      total,
      evidence: [
        diagnostics[0]
          ? `the package's test program does not type-check before any revert: ${describe(diagnostics[0])}`
          : `typecheck-tests.mjs exited ${r.status} with no diagnostics to report`,
      ],
    };
  }
  if (inChanged.length > 0) {
    const hit = new Set(inChanged.map((d) => plan.files.find((f) => samePath(d.file, f)))).size;
    return {
      kind: 'assertion-failure',
      passed: total - hit,
      failed: hit,
      total,
      evidence: inChanged.slice(0, 5).map(describe),
    };
  }
  return {
    kind: 'pass',
    passed: total,
    failed: 0,
    total,
    evidence: elsewhere > 0
      ? [`${elsewhere} diagnostic(s) outside the changed test files (first: ${describe(diagnostics[0])}) -- an old test's types broke, which does not show that THIS branch's tests observe the change`]
      : [],
  };
}

/** Repo-relative file contents at a git revision, '' when the path is absent there. */
export function gitShow(root, rev, path, spawn = spawnSync) {
  const r = spawn('git', ['show', `${rev}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
}
