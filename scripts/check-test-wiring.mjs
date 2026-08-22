#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Guard: nothing in this repo may LOOK enforced while never executing.
 *
 * Part 1 (the original) — every workspace package that contains test files
 * must have a `test` script in its package.json, otherwise `turbo test`
 * silently skips it and the suite never runs in CI (this happened to
 * @ifc-lite/ifcx and @ifc-lite/renderer — 13 test files dark for months).
 *
 * Part 2 — the same absence one directory over. `PACKAGE_DIRS` is
 * `packages` + `apps`, and `scripts/` is neither — yet `scripts/` is where
 * this repo keeps its gates. PR #3062 shipped a gate script AND its test
 * with no workflow step, no package.json script and no turbo task, and
 * nothing flagged it: a guard that is never invoked is the same absence as a
 * guard that finds nothing, and it is invisible in exactly the same way.
 * Parts 2a/2b below make each half of that a hard failure.
 *
 *   2a. GATE SCRIPTS. Every `scripts/check-*.mjs` / `scripts/verify-*.mjs`
 *       must be reachable from a GitHub Actions workflow — either a workflow
 *       naming `scripts/<file>` directly, or a root package.json script that
 *       runs it where that script name is itself reachable from a workflow
 *       through `pnpm <name>` (transitively: check-changesets.mjs is run by
 *       `lint`, and the Lint job runs `pnpm lint`). A package.json entry
 *       ALONE is not wiring — an entry nobody calls executes exactly as often
 *       as no entry at all, which is the vacuity this part exists to reject.
 *
 *   2b. GATE TESTS. Every `*.test.mjs` under `scripts/` must be named by a
 *       workflow `node --test` invocation, literally or through a
 *       single-level `<dir>/*.test.mjs` glob. #3038 added such a catch-all
 *       for `scripts/*.test.mjs` and `scripts/lib/*.test.mjs`, so tests in
 *       those two directories are wired by construction — but only those two:
 *       a bare shell glob has no `**` behaviour, so a test landing in any
 *       other subdirectory of `scripts/` is unrun and unreported, and this is
 *       what notices. It is checked SEPARATELY from 2a on purpose: #3038's
 *       catch-all would otherwise let a gate whose test runs, but whose
 *       script never executes, pass as "wired" — still the #3062 failure.
 *
 * A gate that deliberately does not run in CI (a local pre-push convenience,
 * a developer-facing report, an unadopted proposal) declares itself with an
 * `@unwired-by-design <reason>` line in its own header. Those are listed in
 * this checker's OK output rather than hidden, because an undeclared
 * exception and a declared one differ only in whether anyone can see it.
 *
 * `--root <dir>` points every read at an alternate tree, exactly like
 * scripts/check-test-glob-coverage.mjs's `--root`; the regression harness
 * (scripts/check-test-wiring.test.mjs) uses it to drive the unmodified
 * checker against synthetic fixture trees, never real repo state.
 *
 * Run via `pnpm check:test-wiring` (wired into the CI node-test job); its own
 * regression harness runs in .github/workflows/test.yml.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripYamlComments } from './lib/server-bin-targets-parse.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export class FailError extends Error {}

export function fail(message) {
  console.error(`\ncheck-test-wiring: ${message}\n`);
  process.exitCode = 1;
  throw new FailError(message);
}

const PACKAGE_DIRS = ['packages', 'apps'];
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'pkg', 'build', 'coverage', '.turbo']);

/** A `scripts/*.mjs` whose name declares it a gate. `audit-*` reports, it does not gate. */
const GATE_NAME_RE = /^(?:check|verify)-[\w-]+\.mjs$/;
const SCRIPT_TEST_RE = /\.test\.mjs$/;

/** `@unwired-by-design <reason>` — the declared, visible exception to 2a. */
const UNWIRED_MARKER_RE = /@unwired-by-design\s+(\S[^\n]*)/;
const MIN_REASON_LENGTH = 12;

function findTestFiles(dir, found = []) {
  if (found.length > 0) return found; // one hit is enough
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      findTestFiles(full, found);
      if (found.length > 0) return found;
    } else if (TEST_FILE_RE.test(entry)) {
      found.push(full);
      return found;
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Part 1: packages/ and apps/ (unchanged behaviour)                    *
 * ------------------------------------------------------------------ */

export function auditPackages(root) {
  const offenders = [];
  let examined = 0;
  let parentsSeen = 0;

  for (const parent of PACKAGE_DIRS) {
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;
    parentsSeen++;
    for (const name of readdirSync(parentDir)) {
      const pkgDir = join(parentDir, name);
      const pkgJsonPath = join(pkgDir, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      examined++;
      let pkgJson;
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      } catch (err) {
        fail(`${pkgJsonPath} is not valid JSON: ${err.message}`);
      }
      if (pkgJson.scripts?.test) continue;
      const testFiles = findTestFiles(pkgDir);
      if (testFiles.length > 0) {
        offenders.push({
          name: pkgJson.name ?? `${parent}/${name}`,
          example: relative(root, testFiles[0]).split('\\').join('/'),
        });
      }
    }
  }

  // Anti-vacuity: "0 offenders" must mean "looked and found none", never
  // "looked in the wrong tree". Both of these are silent greens otherwise.
  if (parentsSeen === 0) {
    fail(`no search root found: none of ${PACKAGE_DIRS.map((d) => `${root}/${d}`).join(', ')} exists`);
  }
  if (examined === 0) {
    fail(`found no package.json under ${PACKAGE_DIRS.join('/ or ')}/ in ${root} — the package scan cannot be trusted`);
  }

  return { offenders, examined };
}

/* ------------------------------------------------------------------ *
 * Part 2: scripts/                                                     *
 * ------------------------------------------------------------------ */

/** Every workflow file, comment-stripped so a commented-out step cannot count as wiring. */
export function readWorkflows(root) {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) fail(`no workflow directory at ${dir} — cannot tell what CI runs`);
  const names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort();
  if (names.length === 0) fail(`${dir} contains no .yml/.yaml files — cannot tell what CI runs`);
  return names.map((name) => {
    let source;
    try {
      source = readFileSync(join(dir, name), 'utf8');
    } catch (err) {
      fail(`${join(dir, name)} could not be read: ${err.message}`);
    }
    return { name, text: stripYamlComments(source) };
  });
}

/**
 * True when some workflow RUNS `scripts/<gate>` — the path has to sit on a
 * line that also spawns node. A path can appear in a workflow for reasons
 * that execute nothing (a `paths:` trigger filter, an artifact glob, a
 * `cp`), and reading a bare mention as wiring is the same false green this
 * checker exists to reject, one level up.
 */
export function workflowInvokes(workflows, rel) {
  return workflows.some(({ text }) =>
    text.split('\n').some((line) => line.includes(rel) && /(?:^|[\s;&|"'(])node\s/.test(line)),
  );
}

/** True when `text` invokes the root package.json script `name` as `pnpm [run] <name>`. */
export function invokesPnpmScript(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s;&|"'(])pnpm\\s+(?:run\\s+)?${escaped}(?=$|[\\s;&|"')])`, 'm').test(text);
}

/**
 * Root package.json script names CI actually reaches: seeded from the
 * workflows, then closed transitively over scripts that call other scripts
 * (`release` runs `pnpm test:esm`, so `test:esm` is reached too).
 */
export function reachableScriptNames(pkgScripts, workflowText) {
  const all = Object.keys(pkgScripts);
  const reached = new Set(all.filter((name) => invokesPnpmScript(workflowText, name)));
  const queue = [...reached];
  while (queue.length > 0) {
    const command = pkgScripts[queue.pop()];
    for (const name of all) {
      if (reached.has(name)) continue;
      if (invokesPnpmScript(command, name)) {
        reached.add(name);
        queue.push(name);
      }
    }
  }
  return reached;
}

/**
 * Task names CI fans out across the workspace: `turbo <task>`, `pnpm -r
 * <task>`, `pnpm --filter=<pkg> <task>`. A gate can legitimately live in a
 * WORKSPACE package's script rather than a root one — `check-tla-chunk-await`
 * is the viewer's `build` tail, deliberately, so that Vercel runs it too and
 * not only CI — and reading root scripts alone would red-line it.
 */
const TURBO_TASK_RES = [
  /(?:^|[\s;&|"'(])(?:pnpm\s+(?:exec\s+)?)?turbo\s+(?:run\s+)?([\w:-]+)/gm,
  /(?:^|[\s;&|"'(])pnpm\s+-r\s+(?:run\s+)?([\w:-]+)/gm,
  /(?:^|[\s;&|"'(])pnpm\s+--filter[=\s][^\s]+\s+(?:run\s+)?([\w:-]+)/gm,
];

export function reachableTaskNames(sources) {
  const tasks = new Set();
  for (const source of sources) {
    for (const re of TURBO_TASK_RES) {
      for (const m of source.matchAll(re)) tasks.add(m[1]);
    }
  }
  return tasks;
}

/** `{ [pkgRelPath]: scripts }` for every workspace package under packages/ and apps/. */
export function readWorkspaceScripts(root) {
  const out = [];
  for (const parent of PACKAGE_DIRS) {
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;
    for (const name of readdirSync(parentDir).sort()) {
      const pkgJsonPath = join(parentDir, name, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      try {
        out.push({ rel: `${parent}/${name}`, scripts: JSON.parse(readFileSync(pkgJsonPath, 'utf8')).scripts ?? {} });
      } catch (err) {
        fail(`${pkgJsonPath} is not valid JSON: ${err.message}`);
      }
    }
  }
  return out;
}

/** The declared `@unwired-by-design` reason for a script, or null. */
export function unwiredReason(source) {
  const m = source.match(UNWIRED_MARKER_RE);
  if (!m) return null;
  return m[1].trim();
}

export function auditGateScripts(root, workflows, pkgScripts) {
  const scriptsDir = join(root, 'scripts');
  if (!existsSync(scriptsDir)) fail(`no search root: ${scriptsDir} does not exist`);
  const gates = readdirSync(scriptsDir).filter((n) => GATE_NAME_RE.test(n) && !SCRIPT_TEST_RE.test(n)).sort();
  if (gates.length === 0) {
    fail(`found no check-*.mjs / verify-*.mjs in ${scriptsDir} — the gate scan cannot be trusted`);
  }

  const workflowText = workflows.map((w) => w.text).join('\n');
  const reached = reachableScriptNames(pkgScripts, workflowText);
  const tasks = reachableTaskNames([workflowText, ...[...reached].map((n) => pkgScripts[n])]);
  const workspaces = readWorkspaceScripts(root);

  const offenders = [];
  const declared = [];
  for (const gate of gates) {
    const rel = `scripts/${gate}`;
    if (workflowInvokes(workflows, rel)) continue;
    const via = Object.keys(pkgScripts).filter((n) => pkgScripts[n].includes(rel) && reached.has(n));
    if (via.length > 0) continue;
    // A workspace package's own script, reached by a task CI fans out.
    // The path there is relative (`../../scripts/<name>`), so it still
    // contains `scripts/<name>`.
    const viaWorkspace = workspaces.some(({ scripts }) =>
      Object.entries(scripts).some(([task, cmd]) => tasks.has(task) && cmd.includes(rel)),
    );
    if (viaWorkspace) continue;

    let source;
    try {
      source = readFileSync(join(scriptsDir, gate), 'utf8');
    } catch (err) {
      fail(`${join(scriptsDir, gate)} could not be read: ${err.message}`);
    }
    const reason = unwiredReason(source);
    if (reason === null) {
      const named = Object.keys(pkgScripts).filter((n) => pkgScripts[n].includes(rel));
      offenders.push({ rel, named });
    } else if (reason.length < MIN_REASON_LENGTH) {
      fail(`${rel}: @unwired-by-design needs a reason of at least ${MIN_REASON_LENGTH} characters, got "${reason}"`);
    } else {
      declared.push({ rel, reason });
    }
  }
  return { offenders, declared, examined: gates.length };
}

/** Every `*.test.mjs` under `scripts/`, relative to `root`, POSIX-separated. */
export function findScriptTests(root) {
  const scriptsDir = join(root, 'scripts');
  if (!existsSync(scriptsDir)) fail(`no search root: ${scriptsDir} does not exist`);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SCRIPT_TEST_RE.test(entry)) found.push(relative(root, full).split('\\').join('/'));
    }
  };
  walk(scriptsDir);
  return found.sort();
}

/**
 * Paths a workflow's `node --test` invocations reach: literal file arguments,
 * plus `<dir>/*.test.mjs` shell globs, which match ONE directory level only —
 * no `**` behaviour, which is precisely why 2b cannot be assumed from #3038's
 * catch-all alone. Only lines that actually carry `--test` are read, so a
 * path mentioned in a workflow for some other reason is not mistaken for a
 * runner.
 */
export function testRunnerTargets(workflows) {
  const literals = new Set();
  const globDirs = new Set();
  for (const { text } of workflows) {
    for (const line of text.split('\n')) {
      if (!line.includes('--test')) continue;
      for (const [token] of line.matchAll(/scripts\/[\w./*-]*\.test\.mjs/g)) {
        if (token.includes('*')) {
          const slash = token.lastIndexOf('/');
          const dir = token.slice(0, slash);
          if (!dir.includes('*')) globDirs.add(dir);
        } else {
          literals.add(token);
        }
      }
    }
  }
  return { literals, globDirs };
}

export function auditScriptTests(root, workflows) {
  const tests = findScriptTests(root);
  if (tests.length === 0) {
    fail(`found no *.test.mjs under ${join(root, 'scripts')} — the gate-test scan cannot be trusted`);
  }
  const { literals, globDirs } = testRunnerTargets(workflows);
  const offenders = tests.filter((rel) => {
    if (literals.has(rel)) return false;
    return !globDirs.has(rel.slice(0, rel.lastIndexOf('/')));
  });
  return { offenders, examined: tests.length };
}

/* ------------------------------------------------------------------ */

export function audit(root) {
  const pkgJsonPath = join(root, 'package.json');
  if (!existsSync(pkgJsonPath)) fail(`no ${pkgJsonPath} — cannot resolve what \`pnpm <name>\` runs`);
  let pkgScripts;
  try {
    pkgScripts = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).scripts ?? {};
  } catch (err) {
    fail(`${pkgJsonPath} is not valid JSON: ${err.message}`);
  }
  const workflows = readWorkflows(root);
  return {
    packages: auditPackages(root),
    gates: auditGateScripts(root, workflows, pkgScripts),
    gateTests: auditScriptTests(root, workflows),
  };
}

function main(root) {
  const { packages, gates, gateTests } = audit(root);
  let failed = false;

  if (packages.offenders.length > 0) {
    failed = true;
    console.error('❌ Packages with test files but no `test` script (these tests NEVER run in CI):\n');
    for (const { name, example } of packages.offenders) console.error(`   ${name}  (e.g. ${example})`);
    console.error('\nAdd a `test` script to the package.json (vitest run / tsx --test) or remove the dead test files.');
  }

  if (gates.offenders.length > 0) {
    failed = true;
    console.error('\n❌ Gate scripts nothing in CI runs (these NEVER execute — #3062):\n');
    for (const { rel, named } of gates.offenders) {
      const detail = named.length > 0
        ? `package.json "${named.join('", "')}" runs it, but no workflow runs that script`
        : 'no workflow step and no package.json script runs it';
      console.error(`   ${rel}  (${detail})`);
    }
    console.error(
      '\nAdd a step to .github/workflows/ that runs it (directly, or via a `pnpm <name>`\n' +
        'the workflow already invokes). If it is deliberately not a CI gate, say so in its\n' +
        'header with `@unwired-by-design <reason>` so the exception is visible.',
    );
  }

  if (gateTests.offenders.length > 0) {
    failed = true;
    console.error('\n❌ scripts/ test files no workflow runs (these NEVER execute):\n');
    for (const rel of gateTests.offenders) console.error(`   ${rel}`);
    console.error(
      '\nThe glob catch-all in .github/workflows/test.yml covers `scripts/*.test.mjs` and\n' +
        '`scripts/lib/*.test.mjs` only — a shell glob has no `**`. Move the file into one of\n' +
        'those directories, or add a `node --test` step naming it.',
    );
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ check-test-wiring: OK (${packages.examined} packages, ${gates.examined} gate scripts, ` +
      `${gateTests.examined} scripts/ test files).`,
  );
  for (const { rel, reason } of gates.declared) {
    console.log(`   not a CI gate by declaration: ${rel} — ${reason}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootFlagIdx = process.argv.indexOf('--root');
  if (rootFlagIdx !== -1 && !process.argv[rootFlagIdx + 1]) {
    console.error('\ncheck-test-wiring: --root requires a directory argument\n');
    process.exit(1);
  }
  const arg = rootFlagIdx === -1 ? null : process.argv[rootFlagIdx + 1];
  const root = arg === null ? join(SCRIPT_DIR, '..') : (arg.startsWith('/') ? arg : join(process.cwd(), arg));
  try {
    main(root);
  } catch (err) {
    if (!(err instanceof FailError)) throw err;
  }
}
