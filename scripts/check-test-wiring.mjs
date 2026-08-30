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
 * Part 2 — the same absence one directory over. `PACKAGE_PARENTS` is
 * `packages` + `apps`, and `scripts/` is neither — yet `scripts/` is where
 * this repo keeps its gates. PR #3062 shipped a gate script AND its test
 * with no workflow step, no package.json script and no turbo task, and
 * nothing flagged it: a guard that is never invoked is the same absence as a
 * guard that finds nothing, and it is invisible in exactly the same way.
 * Parts 2a/2b below make each half of that a hard failure.
 *
 *   2a. GATE SCRIPTS. Every `check-*` / `verify-*` script under `scripts/`
 *       — at ANY depth, and in `.mjs`, `.js` or `.cjs` — must be reachable
 *       from a GitHub Actions workflow: a workflow naming `scripts/<file>`
 *       directly, or a root package.json script that runs it where that
 *       script name is itself reachable from a workflow through `pnpm <name>`
 *       (transitively: check-changesets.mjs is run by `lint`, and the Lint
 *       job runs `pnpm lint`), or a workspace package's script reached by a
 *       task CI fans out, or — one layer below all of those — a file that a
 *       script already reached imports or spawns. A package.json entry ALONE
 *       is not wiring: an entry nobody calls executes exactly as often as no
 *       entry at all, which is the vacuity this part exists to reject.
 *
 *   2b. GATE TESTS. Every `*.test.mjs` under `scripts/` must be named by a
 *       workflow `node --test` invocation, literally or through a
 *       single-level `<dir>/*.test.mjs` glob. #3038 added such a catch-all,
 *       which has since grown to `scripts/`, `scripts/lib/`,
 *       `scripts/fixtures/` and `scripts/docs/`, so tests in those
 *       directories are wired by construction — but only those: a bare shell
 *       glob has no `**` behaviour, so a test landing in any other
 *       subdirectory of `scripts/` is unrun and unreported, and this is what
 *       notices. The directory list is not restated in the failure message —
 *       that message is derived from the workflow text, because the list here
 *       drifted once already. It is checked SEPARATELY from 2a on purpose: #3038's
 *       catch-all would otherwise let a gate whose test runs, but whose
 *       script never executes, pass as "wired" — still the #3062 failure.
 *
 * A gate that deliberately does not run in CI (a local pre-push convenience,
 * a developer-facing report, an unadopted proposal) declares itself with an
 * `@unwired-by-design <reason>` line in its own header. Those are listed in
 * this checker's OK output rather than hidden, because an undeclared
 * exception and a declared one differ only in whether anyone can see it. The
 * marker is a BLANKET escape and nothing here judges the reason's quality —
 * see `unwiredReason` for what that does and does not buy.
 *
 * WHAT THIS CHECK CANNOT SEE. It is lexical throughout — it reads workflow
 * text, it never evaluates it — and two consequences are worth stating rather
 * than discovering:
 *
 *   - JOB AND STEP CONDITIONS ARE NOT EVALUATED. A gate whose only step sits
 *     in a job with `if: false`, or behind a `github.event_name` guard that
 *     never holds, counts as wired here. Deciding otherwise would mean
 *     evaluating GitHub Actions expressions against a hypothetical event
 *     payload, which is a different program from this one. "Wired" here means
 *     "some workflow line spawns it", not "it ran on this commit".
 *
 *   - THE SPAWN TEST IS PER-LINE, NOT PER-COMMAND. `workflowInvokes` asks
 *     whether a line both names the path and spawns node, so
 *     `node -e "1" && cp scripts/check-copied.mjs /tmp/x` satisfies it even
 *     though the `node` and the path belong to different commands. It is a
 *     heuristic, chosen over a shell parser: it already rejects the shapes
 *     that occur (a `paths:` filter, an artifact glob, a commented-out step),
 *     and the residue takes deliberate effort to construct.
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
import { listWorkspacePackages } from './lib/list-workspace-packages.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

// Deliberately a literal here rather than imported from the shared walk.
// `scripts/lib/ci-path-coverage.mjs`'s `deriveInputs` reads only THIS file's own
// source text and does not follow imports, so these two strings are what put
// `packages/` and `apps/` into the CI-path-coverage census for this gate. Move
// them into the lib and the ratchet silently stops checking that this gate can
// be triggered by the paths it reads. (#3347)
const PACKAGE_PARENTS = ['packages', 'apps'];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export class FailError extends Error {}

export function fail(message) {
  console.error(`\ncheck-test-wiring: ${message}\n`);
  process.exitCode = 1;
  throw new FailError(message);
}

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'pkg', 'build', 'coverage', '.turbo']);

/**
 * A script whose name declares it a gate. `audit-*` reports, it does not gate.
 *
 * `.js`/`.cjs` are included because this repo HAS gate-named ones —
 * `scripts/verify-npm-publish.js` (release.yml) and
 * `scripts/check-benchmark-regression.js` (benchmark.yml) — so an `.mjs`-only
 * pattern would have let an unwired `scripts/check-anything.js` through by
 * file extension alone. Nothing non-gate is swept in: the only other
 * `scripts/**` file with either extension is `sync-versions.js`, which the
 * `check-`/`verify-` prefix already excludes.
 */
const GATE_NAME_RE = /^(?:check|verify)-[\w-]+\.(?:mjs|js|cjs)$/;
/** Any script file, gate-named or not — the graph 2a's transitive reach walks. */
const SCRIPT_FILE_RE = /\.(?:mjs|js|cjs)$/;
/** A gate's own harness is not itself a gate, in any of the three extensions. */
const TEST_SUFFIX_RE = /\.(?:test|spec)\.(?:mjs|js|cjs)$/;
/** 2b's scope: `node --test scripts/*.test.mjs` globs, so `.mjs` specifically. */
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
 * Part 1: packages/ and apps/ — and the package discovery Part 2 shares  *
 * ------------------------------------------------------------------ */

export function auditPackages(root) {
  const offenders = [];
  const { packages, seenParents } = listWorkspacePackages(root, fail, PACKAGE_PARENTS);

  for (const { rel, dir, pkgJson } of packages) {
    if (pkgJson.scripts?.test) continue;
    const testFiles = findTestFiles(dir);
    if (testFiles.length > 0) {
      offenders.push({
        name: pkgJson.name ?? rel,
        example: relative(root, testFiles[0]).split('\\').join('/'),
      });
    }
  }

  // Anti-vacuity: "0 offenders" must mean "looked and found none", never
  // "looked in the wrong tree". Both of these are silent greens otherwise.
  if (seenParents.length === 0) {
    fail(`no search root found: none of ${PACKAGE_PARENTS.map((d) => `${root}/${d}`).join(', ')} exists`);
  }
  if (packages.length === 0) {
    fail(`found no package.json under ${PACKAGE_PARENTS.join('/ or ')}/ in ${root} — the package scan cannot be trusted`);
  }

  return { offenders, examined: packages.length };
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
      throw err;
    }
    return { name, text: stripYamlComments(source) };
  });
}

/**
 * True when some workflow RUNS `rel` — the path has to sit on a line that also
 * spawns node. A path can appear in a workflow for reasons that execute
 * nothing (a `paths:` trigger filter, an artifact glob, a `cp`), and reading a
 * bare mention as wiring is the same false green this checker exists to
 * reject, one level up.
 *
 * PER LINE, NOT PER COMMAND: this asks only whether ONE line carries both the
 * path and a `node` spawn, so `node -e "1" && cp scripts/check-copied.mjs
 * /tmp/x` passes even though the `node` and the path belong to different
 * commands, as does any other line that pairs an unrelated node invocation
 * with a mention. Splitting on shell operators would not fix it either — the
 * honest fix is a shell parser, and this is a heuristic instead: it rejects
 * the shapes that actually occur, and the residue has to be built on purpose.
 */
export function workflowInvokes(workflows, rel) {
  return workflows.some(({ text }) =>
    text.split('\n').some((line) => line.includes(rel) && /(?:^|[\s;&|"'(])node\s/.test(line)),
  );
}

/**
 * A workflow with its `name:` values removed. A step's `name:` is a LABEL — it
 * executes nothing — so a step called `name: run pnpm lint first` must not
 * count as invoking `pnpm lint`. Not live today (`pnpm lint` is a real `run:`
 * in the Lint job), but a gate that can be wired by naming a step is a gate
 * that can be wired by writing a sentence.
 *
 * Only `name:` is dropped, deliberately, and NOT everything outside `run:`:
 * `verify-esm-entrypoints.mjs`'s real wiring is `publish-script: pnpm run
 * release` — a `with:` input the changesets action executes — and a `run:`-only
 * reading red-lines it. This is a lexical filter, so it also drops a shell line
 * inside a `run:` block that happens to look like a YAML `name:` key; that
 * narrows what counts as wiring, never widens it.
 */
export function workflowExecutableText(workflows) {
  return workflows
    .map(({ text }) => text.split('\n').filter((line) => !/^\s*(?:-\s+)?name:\s/.test(line)).join('\n'))
    .join('\n');
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

/**
 * `{ [pkgRelPath]: scripts }` for every workspace package under packages/ and
 * apps/. A PROJECTION of the same `listWorkspacePackages` function the audit
 * uses: one discovery FUNCTION with two readers. Still called once per reader,
 * so it is a second walk of the same tree at run time. That is deliberate and
 * cheap at this size (two parents, ~50 entries); the thing worth keeping is
 * that both readers now agree on WHAT a package is, not that they share a pass.
 */
export function readWorkspaceScripts(root) {
  return listWorkspacePackages(root, fail, PACKAGE_PARENTS).packages.map(({ rel, pkgJson }) => ({
    rel,
    scripts: pkgJson.scripts ?? {},
  }));
}

/**
 * The declared `@unwired-by-design` reason for a script, or null.
 *
 * The reason runs to end of line, so a one-line block comment
 * (`/** @unwired-by-design because X *\/`) carries the comment terminator into
 * the captured text; it is stripped so the OK output prints the reason and not
 * the syntax around it.
 *
 * Known property, not an oversight: this marker is a BLANKET escape. Nothing
 * here can judge whether a stated reason is a good one — `@unwired-by-design
 * because I said so` satisfies the length floor and passes. The only thing
 * that makes it safer than silence is that every declaration is printed in the
 * OK output and lives in the diff, so an exception is reviewable rather than
 * invisible. That visibility is the whole of the mitigation.
 */
export function unwiredReason(source) {
  const m = source.match(UNWIRED_MARKER_RE);
  if (!m) return null;
  return m[1].trim().replace(/\s*\*\/\s*$/, '').trim();
}

/**
 * Every script file under `scripts/`, at ANY depth, relative to `root` and
 * POSIX-separated — the same recursive walk `findScriptTests` does, for the
 * same reason. A flat `readdirSync` here would make the two halves of this
 * checker disagree about whether `scripts/` has subdirectories: 2b walks the
 * whole tree, and its own failure text tells authors to MOVE FILES BETWEEN
 * DIRECTORIES, which is advice that walks straight into a flat scan's blind
 * spot. `scripts/ci/check-anything.mjs` is not a special case; it is what that
 * advice produces.
 */
export function findScriptFiles(root) {
  const scriptsDir = join(root, 'scripts');
  if (!existsSync(scriptsDir)) fail(`no search root: ${scriptsDir} does not exist`);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SCRIPT_FILE_RE.test(entry)) found.push(relative(root, full).split('\\').join('/'));
    }
  };
  walk(scriptsDir);
  return found.sort();
}

/** POSIX path arithmetic only — `resolveRef` never touches the filesystem. */
function resolveRef(dir, token) {
  if (token.startsWith('scripts/')) return token;
  const parts = [];
  for (const seg of `${dir}/${token}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Blank `//` and block comments to spaces, keeping newlines and every offset,
 * so a filename NAMED IN PROSE cannot be read as a reference.
 *
 * This is load-bearing rather than tidiness. This repo's comment convention
 * puts filenames in BACKTICKS — `` `scripts/check-x.mjs` `` — and a backtick is
 * a quote, so "only quoted tokens count" does not exclude prose at all: a
 * one-line historical note in any already-wired script would otherwise confer
 * reach on a gate nothing runs, which is the exact absence this file exists to
 * find. `check-test-wiring.mjs`'s own header names
 * `scripts/moonshot/diff-spike/verify-common.mjs` that way.
 *
 * Strings are tracked so a `'https://…'` is not mistaken for a comment. Regex
 * literals are not, which can only DROP a reference (a red), never invent one.
 */
function blankScriptComments(source) {
  let out = '';
  let i = 0;
  let quote = '';
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = '';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += i < source.length ? '  ' : '';
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The `scripts/` files a given script's source names, resolved to repo-relative
 * paths — its static imports, its `spawn`/`fork` targets, anything it opens by
 * path. Comments are blanked first and only then do QUOTED tokens count, so a
 * filename mentioned in prose or a header comment is not mistaken for a
 * reference; a bare specifier (`'./x.mjs'`, or the `'verify-worker.mjs'` that a
 * `path.join(HERE, ...)` hands to a worker) resolves against the referencing
 * file's own directory, and a token already rooted at `scripts/` is taken as
 * written. Anything not resolving to a file in `known` is dropped.
 */
export function referencedScriptFiles(source, fromRel, known) {
  const out = new Set();
  const dir = fromRel.slice(0, fromRel.lastIndexOf('/'));
  for (const [, token] of blankScriptComments(source).matchAll(/['"`]([\w./-]+\.(?:mjs|js|cjs))['"`]/g)) {
    const candidate = resolveRef(dir, token);
    if (known.has(candidate)) out.add(candidate);
  }
  return out;
}

/**
 * True when some workflow, some root package.json script CI reaches, or some
 * workspace script a fanned-out task reaches, runs `rel` DIRECTLY.
 */
function directlyWired(rel, { workflows, pkgScripts, reachedNames, tasks, workspaces }) {
  if (workflowInvokes(workflows, rel)) return true;
  if (Object.keys(pkgScripts).some((n) => pkgScripts[n].includes(rel) && reachedNames.has(n))) return true;
  // A workspace package's own script, reached by a task CI fans out. The path
  // there is relative (`../../scripts/<name>`), so it still contains `rel`.
  return workspaces.some(({ scripts }) =>
    Object.entries(scripts).some(([task, cmd]) => tasks.has(task) && cmd.includes(rel)),
  );
}

/**
 * Every `scripts/` file that EXECUTES in CI: the directly-wired ones, closed
 * transitively over what each of them imports or spawns.
 *
 * This is the same transitivity 2a already applies to package.json scripts
 * (`check-changesets.mjs` <- `lint` <- the Lint job), one layer down, and the
 * recursive scan makes it necessary rather than optional: below the top level,
 * `check-`/`verify-` names belong to library modules and worker entrypoints at
 * least as often as to gates. `scripts/moonshot/diff-spike/verify-common.mjs`
 * is a module the workflow-wired `verify-trajectory.mjs` imports, and demanding
 * a workflow step of it would be a false positive, not a finding. A file a
 * running gate imports does run.
 *
 * TWO EDGES ARE DELIBERATELY NOT FOLLOWED, because each would let this check
 * pass the very absence it exists to find:
 *
 *   - A COMMENT. See `blankScriptComments`: prose names files in backticks
 *     here, so an unwired gate mentioned in any wired script's header would
 *     otherwise read as reachable.
 *   - A TEST FILE. A gate's harness spawns the gate, so expanding through
 *     `check-x.test.mjs` would make 2a satisfiable by 2b — the `node --test`
 *     step wired, the gate step forgotten, the gate never run against the
 *     repo. Tests are still reached; they just confer nothing.
 */
export function reachableScriptFiles(root, context) {
  const all = findScriptFiles(root);
  const known = new Set(all);
  const reached = new Set(all.filter((rel) => directlyWired(rel, context)));
  // A TEST never confers reach on what it names. A gate's own harness spawns
  // the gate by construction, so expanding through `check-x.test.mjs` would
  // make 2a satisfiable by 2b: wire the `node --test` step, leave the gate
  // step out, and the gate that never runs against the REPO reads as wired.
  // That is #3062 exactly, and it is what the 2a/2b split exists to reject.
  const queue = [...reached].filter((rel) => !TEST_SUFFIX_RE.test(rel.slice(rel.lastIndexOf('/') + 1)));
  while (queue.length > 0) {
    const rel = queue.pop();
    let source;
    try {
      source = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue; // an unreadable neighbour narrows the reach, it never widens it
    }
    for (const ref of referencedScriptFiles(source, rel, known)) {
      if (reached.has(ref)) continue;
      reached.add(ref);
      if (!TEST_SUFFIX_RE.test(ref.slice(ref.lastIndexOf('/') + 1))) queue.push(ref);
    }
  }
  return { all, reached };
}

export function auditGateScripts(root, workflows, pkgScripts) {
  const workflowRun = workflowExecutableText(workflows);
  const reachedNames = reachableScriptNames(pkgScripts, workflowRun);
  const tasks = reachableTaskNames([workflowRun, ...[...reachedNames].map((n) => pkgScripts[n])]);
  const workspaces = readWorkspaceScripts(root);
  const context = { workflows, pkgScripts, reachedNames, tasks, workspaces };

  const { all, reached } = reachableScriptFiles(root, context);
  const gates = all.filter((rel) => {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    return GATE_NAME_RE.test(base) && !TEST_SUFFIX_RE.test(base);
  });
  if (gates.length === 0) {
    fail(`found no check-* / verify-* script under ${join(root, 'scripts')} — the gate scan cannot be trusted`);
  }

  const offenders = [];
  const declared = [];
  for (const rel of gates) {
    if (reached.has(rel)) continue;

    let source;
    try {
      source = readFileSync(join(root, rel), 'utf8');
    } catch (err) {
      fail(`${join(root, rel)} could not be read: ${err.message}`);
      throw err;
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

/**
 * Every `*.test.mjs` under `scripts/`, relative to `root`, POSIX-separated.
 *
 * A FILTER over `findScriptFiles`, not a second walk. The two halves of this
 * checker having their own traversals is what let them disagree about whether
 * `scripts/` has subdirectories; one walk, filtered twice, cannot drift.
 */
export function findScriptTests(root) {
  return findScriptFiles(root).filter((rel) => SCRIPT_TEST_RE.test(rel));
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
  return { offenders, examined: tests.length, globDirs: [...globDirs].sort() };
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
    throw err;
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
    // Derived, not restated. This advice named `scripts/` and `scripts/lib/`
    // as a fixed pair from #3038; the workflow glob later grew
    // `scripts/fixtures/` and `scripts/docs/` and the sentence did not, so it
    // was sending developers to two of the four directories that would have
    // worked. Reading the same `globDirs` the verdict above is computed from
    // makes the two structurally incapable of disagreeing.
    const covered = gateTests.globDirs.map((d) => `\`${d}/*.test.mjs\``);
    console.error(
      covered.length === 0
        ? '\nNo workflow runs a `<dir>/*.test.mjs` catch-all at all, so every scripts/ test\n' +
            'must be named by its own `node --test` step. Add one.'
        : `\nThe glob catch-alls in .github/workflows/ cover ${covered.join(', ')}\n` +
            'only — a shell glob has no `**`. Move the file into one of those directories, or\n' +
            'add a `node --test` step naming it.',
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

if (isMainEntry(import.meta.url)) {
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
