#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Selected viewer tests on a fast-lane PR run: the viewer test files a PR's
 * changes can reach through the static import graph, capped to a time budget.
 *
 * WHY. With `CI_PR_LANE=fast` a PR run skips the sixteen viewer shards, so a
 * viewer failure is first seen in the merge queue's full run. A red queue run
 * costs about seven runner-hours, resets the batches behind it and sends the PR
 * round the queue again. Running the few viewer tests a change can affect, on
 * the PR, tells the author in minutes.
 *
 * ADVISORY, NOT A GATE. The job is not in the aggregate's `needs`, it carries
 * job-level `continue-on-error`, and `--run` exits 0 when tests fail (with a
 * warning annotation, the summary and a result file in the artifact). A red
 * advisory job would turn the whole Test run's conclusion to failure, and
 * scripts/ci-push-replay.mjs replays only a PR run that concluded success, so
 * a flake here would cost a full re-run on the push to main. The merge queue
 * still runs the whole suite and is still the gate. A pass here means "the
 * sampled tests passed", never "the viewer suite passes".
 *
 * THE SWITCH is the repo variable `CI_PR_VIEWER_SELECT`:
 *   unset / `off`  the job is skipped by its `if:`; nothing runs.
 *   `shadow`       the selection is computed and uploaded, no test runs.
 *   `on`           the selected tests run.
 * Any other value is `off`. Like `CI_PR_LANE` it is compared lowercased, not
 * trimmed, to match Actions' case-insensitive `==` in the job's `if:`. Only a
 * fast-lane `pull_request` that is not a Mergify batch and not a no-op `edited`
 * replay selects anything; this script re-derives that rather than trusting the
 * job condition.
 *
 * FAIL CLOSED. A changed file the graph cannot map (config, lockfile, build
 * scripts, WASM or Rust input, a file read at runtime) selects NOTHING extra and
 * is listed in the summary as unmapped. An error reading the diff or the graph
 * exits 1, which shows on the job but cannot fail the run. A run that selects nothing is green with zero
 * tests, which is what an advisory job should say; the summary gives the
 * counts, so green here never means "the viewer tests passed".
 *
 *   node scripts/ci-viewer-select.mjs --select <dir>
 *       writes <dir>/selection.json and <dir>/files.txt, outputs run/count
 *   node scripts/ci-viewer-select.mjs --run <dir>
 *       runs <dir>/files.txt with the viewer `test` script's own tsx command,
 *       writes <dir>/result.json, and exits 0 even when tests fail
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isBatchBranch } from './ci-pr-lane.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { parseManifest, pathHash } from './viewer-test-shards.mjs';
import { median } from './lib/viewer-test-durations.mjs';
import {
  affectedTests, buildGraph, createResolver, extensionless, isCodeFile, isViewerTest, packageNode,
} from './lib/viewer-import-graph.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = 'apps/viewer';
/** A repo-relative viewer path as apps/viewer's scripts and manifest spell it. */
const local = (p) => posix.relative(VIEWER, p);

export const MODES = ['off', 'shadow', 'on'];

/**
 * Seconds of measured test time (apps/viewer/test-durations.json) the job may
 * run. With install, artifact download and fixture restore on top, the job
 * stays near ten minutes.
 */
export const BUDGET_SECONDS = 420;

/** Pure decision. */
export function decideViewerSelect({ mode, event, lane, headRef, noop }) {
  const raw = String(mode ?? '').toLowerCase();
  const m = MODES.includes(raw) ? raw : 'off';
  const warning = raw !== '' && m !== raw
    ? `CI_PR_VIEWER_SELECT=${JSON.stringify(String(mode))} is not one of ${MODES.join(', ')}; treating it as off`
    : undefined;
  const no = (reason) => ({ mode: m, select: false, runTests: false, reason, warning });
  if (m === 'off') return no('CI_PR_VIEWER_SELECT is unset, off or unrecognised');
  if (event !== 'pull_request') return no(`${event || 'unknown event'} runs the full viewer suite`);
  if (isBatchBranch(headRef)) return no('a Mergify batch PR runs the full viewer suite');
  if (noop === 'true') return no('a no-op edit replays the recorded verdict');
  if (lane !== 'fast') return no('the full lane runs every viewer shard');
  return { mode: m, select: true, runTests: m === 'on', reason: `CI_PR_VIEWER_SELECT=${m} on a fast-lane PR`, warning };
}

/** Why a changed file outside the graph cannot be mapped to viewer tests. */
export function unmappableReason(path) {
  if (/^rust\/|^packages\/wasm\/|(^|\/)Cargo\.(toml|lock)$|^rust-toolchain/.test(path)) {
    return 'WASM or Rust input: reaches viewer tests through the built bundle, not a source import';
  }
  if (/(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|turbo\.json|\.npmrc)$|(^|\/)vite\.config\.[^/]+$/.test(path)) {
    return 'dependency or build configuration';
  }
  if (/^\.github\/|^scripts\/|^apps\/viewer\/test-durations\.json$/.test(path)) return 'CI, test-runner or build script';
  if (/(^|\/)generated\//.test(path)) return 'generated file no viewer test imports';
  if (path.startsWith(`${VIEWER}/`) || path.startsWith('packages/')) {
    return 'not a module any viewer test imports (it may be read at runtime)';
  }
  return 'outside the viewer import graph';
}

/**
 * The package directory holding `path`, and whether `path` is in its `src/`.
 * packages/wasm is built from Rust, so it is never a source package here.
 */
function packageOf(path) {
  const root = /^packages\/(?!wasm\/)[^/]+(?=\/)/.exec(path)?.[0];
  const rest = root ? path.slice(root.length + 1) : '';
  return { root, src: rest.startsWith('src/'), built: /^(src|generated)\//.test(rest) };
}

/**
 * Classify each changed file and collect the graph seeds.
 *
 * @param {Array<{ status: string, path: string }>} changes
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {Map<string, { dir: string }>} packages
 */
export function classifyChanges(changes, graph, packages) {
  const pkgByDir = new Map([...packages].map(([name, p]) => [p.dir, name]));
  // Only data directories strictly inside an app's or package's `src/` or
  // `public/`: a module that takes a ROOT as its working directory would
  // otherwise claim every config file under it and hide the unmapped warning.
  // graph.dirs holds every relative path a module names, however spelled.
  const dirImportersOf = (k) => [...(graph.dirs.get(k) ?? [])];
  const dirKeys = [...graph.dirs.keys()].filter((k) => /^(apps|packages)\/[^/]+\/(src|public)\/.+$/.test(k));
  const seeds = new Set();
  const rows = [];
  for (const { status, path } of changes) {
    const pkg = packageOf(path);
    const pkgName = pkg.root && pkgByDir.get(pkg.root);
    // A package reached opaquely runs its BUILT entry, compiled (and bundled)
    // from its src/ and generated/ files, so seed it alongside any file match.
    const opaque = pkgName && pkg.built && graph.nodes.has(packageNode(pkgName)) ? packageNode(pkgName) : null;
    if (opaque) seeds.add(opaque);
    if (status === 'D') {
      // `import './dir'` resolved to dir/index.ts records the directory itself.
      // A deleted dir/index also breaks `./dir` and `./dir/` imports (graph.dirs).
      const index = isCodeFile(path) && /\/index\.[^/]+$/.test(path) ? posix.dirname(path) : null;
      const importers = [
        ...(graph.missing.get(extensionless(path)) ?? []),
        ...(index ? dirImportersOf(index) : []),
      ];
      if (importers.length > 0) {
        for (const i of importers) seeds.add(i);
        rows.push({ path, status, class: 'graph', reason: 'deleted; still imported by the graph' });
        continue;
      }
    } else if (graph.nodes.has(path)) {
      seeds.add(path);
      rows.push({ path, status, class: 'graph', reason: 'in the import graph' });
      continue;
    }
    // A data directory a module reads (`new URL('dir/', import.meta.url)`)
    // covers the DATA files under it. Code files there are judged by imports,
    // so a module reading `./` cannot mask unreached source.
    const dirImporters = isCodeFile(path) ? [] : dirKeys.filter((k) => path.startsWith(`${k}/`)).flatMap(dirImportersOf);
    if (dirImporters.length > 0) {
      for (const i of dirImporters) seeds.add(i);
      rows.push({ path, status, class: 'graph', reason: 'in a directory a graph module reads' });
      continue;
    }
    if (opaque) {
      rows.push({ path, status, class: 'graph', reason: `source of ${pkgName}, which a viewer test imports opaquely` });
      continue;
    }
    // Only a SOURCE file can be judged by the graph. A deleted config, lockfile
    // or runtime input stays unmapped below, with its reason.
    const isSource = (path.startsWith(`${VIEWER}/src/`) || pkg.src) && isCodeFile(path);
    if (isSource && status === 'D') {
      rows.push({ path, status, class: 'deleted', reason: 'deleted; nothing in the graph imports it' });
      continue;
    }
    if (isSource) {
      rows.push({ path, status, class: 'unreached', reason: 'source file no viewer test imports statically' });
      continue;
    }
    rows.push({ path, status, class: 'unmapped', reason: unmappableReason(path) });
  }
  return { rows, seeds };
}

/**
 * Order the affected tests nearest first (a changed test, then direct
 * importers, ...), ties by the shard path hash and then path, and take them
 * greedily while they fit the budget. Deterministic for a given diff and tree.
 *
 * @param {Map<string, number>} affected  repo-relative test path -> distance
 * @param {Record<string, number>} seconds  `test-durations.json` (paths relative to apps/viewer)
 */
export function sampleWithinBudget(affected, seconds, budget = BUDGET_SECONDS) {
  const fallback = median(Object.values(seconds)) || 5;
  const cost = (p) => seconds[local(p)] ?? fallback;
  const order = [...affected].sort(([pa, da], [pb, db]) => da - db || pathHash(local(pa)) - pathHash(local(pb)) || (pa < pb ? -1 : pa > pb ? 1 : 0));
  const ran = [];
  const leftOut = [];
  let used = 0;
  for (const [p] of order) {
    if (used + cost(p) <= budget) {
      ran.push(p);
      used += cost(p);
    } else {
      leftOut.push(p);
    }
  }
  return { ran, leftOut, estimatedSeconds: Math.round(used), fallbackSeconds: fallback };
}

/** `git diff --name-status -z` output -> [{ status, path }]. */
export function parseNameStatus(raw) {
  const parts = raw.split('\0').filter((x) => x !== '');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] });
  return out;
}

/** The modules the viewer `test` script preloads with `--import`, repo-relative. */
export function preloadsFromTestScript(script) {
  return [...String(script).matchAll(/--import[= ](\S+)/g)].map((m) => posix.normalize(posix.join(VIEWER, m[1])));
}

/** The tsx argv the viewer `test` script runs its file list with. */
export function runnerArgs(script) {
  const m = /&&\s*(tsx\s[^&|;]*?)\s+\$files\s*$/.exec(String(script));
  if (!m) throw new Error('cannot find `tsx ... $files` in apps/viewer\'s test script; update runnerArgs');
  // The shards read their concurrency from a shell variable (VIEWER_TEST_CONCURRENCY, default 1).
  // This job runs without a shell, always serial, so that variable is pinned to its default.
  return m[1].split(/\s+/).map((a) => (a === '--test-concurrency=$c' ? '--test-concurrency=1' : a));
}

/** Read the repo state the graph needs. */
function loadRepo(root) {
  const files = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean));
  const viewerPkg = JSON.parse(readFileSync(join(root, VIEWER, 'package.json'), 'utf8'));
  const tsconfig = JSON.parse(readFileSync(join(root, VIEWER, 'tsconfig.json'), 'utf8'));
  const aliases = Object.entries(tsconfig.compilerOptions?.paths ?? {}).map(([pattern, targets]) => ({
    pattern,
    targets: targets.map((t) => posix.normalize(posix.join(VIEWER, tsconfig.compilerOptions.baseUrl ?? '.', t))),
  }));
  const packages = new Map();
  for (const dir of readdirSync(join(root, 'packages'))) {
    let pj;
    try {
      pj = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;
      throw err;
    }
    if (pj.name) packages.set(pj.name, { dir: `packages/${dir}`, exports: pj.exports, main: pj.main });
  }
  const durations = parseManifest(readFileSync(join(root, VIEWER, 'test-durations.json'), 'utf8')).seconds;
  return { files, aliases, packages, script: viewerPkg.scripts?.test ?? '', durations };
}

/** The whole computation over a repo checkout, separated from the CLI for tests. */
export function computeSelection({ root, changes, budget = BUDGET_SECONDS }) {
  const repo = loadRepo(root);
  const resolve = createResolver(repo);
  const tests = [...repo.files].filter(isViewerTest).sort();
  const graph = buildGraph({
    tests,
    preloads: preloadsFromTestScript(repo.script),
    read: (p) => readFileSync(join(root, p), 'utf8'),
    resolve,
  });
  const { rows, seeds } = classifyChanges(changes, graph, repo.packages);
  const affected = affectedTests(graph, seeds);
  const sample = sampleWithinBudget(affected, repo.durations, budget);
  return {
    budgetSeconds: budget,
    graph: { tests: tests.length, nodes: graph.nodes.size },
    changes: rows,
    selected: [...affected.keys()].sort(),
    distance: Object.fromEntries([...affected].sort(([a], [b]) => (a < b ? -1 : 1))),
    ...sample,
  };
}

const CAP = 40;
const list = (items, fmt) => [...items.slice(0, CAP).map(fmt), ...(items.length > CAP ? [`- ... and ${items.length - CAP} more (see the artifact)`] : [])];

export function summaryLines(decision, sel) {
  const lines = [`## Selected viewer tests (\`CI_PR_VIEWER_SELECT=${decision.mode}\`)`, ''];
  if (!decision.select) return [...lines, `Nothing selected: ${decision.reason}.`];
  const count = (cls) => sel.changes.filter((c) => c.class === cls).length;
  const mapped = sel.changes.filter((c) => c.class === 'graph').length;
  lines.push(
    'Advisory only. The merge queue runs the whole viewer suite and remains the gate.',
    '',
    `- changed files: ${sel.changes.length} (${mapped} in the viewer import graph, ${count('deleted')} deletions nothing imports, ${count('unmapped') + count('unreached')} NOT covered: ${count('unmapped')} unmapped, ${count('unreached')} reached by no static import)`,
    `- viewer test files the changes reach: ${sel.selected.length} of ${sel.graph.tests}`,
    `- ${decision.runTests ? 'run' : 'would run'}: ${sel.ran.length} (about ${sel.estimatedSeconds} s of the ${sel.budgetSeconds} s budget)`,
    `- left out by the budget: ${sel.leftOut.length}`,
  );
  // `unreached` belongs here too: "no static import reaches it" is not "no
  // test is affected" (a runtime-built import or a read by path is invisible).
  const uncovered = sel.changes.filter((c) => c.class === 'unmapped' || c.class === 'unreached');
  if (uncovered.length > 0) {
    lines.push('', `**${uncovered.length} changed file(s) could not be mapped to viewer tests or are reached by no static import, and selected nothing.** Viewer tests they affect are NOT covered here:`, '');
    lines.push(...list(uncovered, (c) => `- \`${c.path}\`: ${c.reason}`));
  }
  if (sel.leftOut.length > 0) {
    lines.push('', `**${sel.leftOut.length} reachable test file(s) were left out by the budget** (tests were taken nearest first; one that did not fit was skipped and a smaller, farther one may have run):`, '');
    lines.push(...list(sel.leftOut, (p) => `- \`${p}\``));
  }
  if (!decision.runTests) lines.push('', 'Shadow mode: no test ran.');
  return lines;
}

function writeSummary(env, lines) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function setOutputs(env, outputs) {
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
}

export function run(argv, env = process.env, root = ROOT) {
  const [cmd, dir] = argv;
  if ((cmd !== '--select' && cmd !== '--run') || !dir) {
    throw new Error('usage: --select <dir> | --run <dir>');
  }
  if (cmd === '--run') {
    const files = readFileSync(join(dir, 'files.txt'), 'utf8').split('\n').filter(Boolean);
    if (files.length === 0) throw new Error('files.txt is empty; tsx would fall back to its default glob');
    const pkg = JSON.parse(readFileSync(join(root, VIEWER, 'package.json'), 'utf8'));
    const [bin, ...args] = runnerArgs(pkg.scripts?.test);
    const r = spawnSync('pnpm', ['exec', bin, ...args, ...files], { cwd: join(root, VIEWER), stdio: 'inherit' });
    if (r.error) throw r.error;
    const status = r.status ?? 1;
    writeFileSync(join(dir, 'result.json'), `${JSON.stringify({ files: files.length, exitCode: status, signal: r.signal ?? null })}\n`);
    if (status !== 0) {
      const msg = `Advisory: ${files.length} selected viewer test file(s) ran and at least one failed (exit ${status}). The merge queue runs the full suite; see the log above.`;
      console.log(`::warning title=Selected viewer tests (advisory)::${msg}`);
      writeSummary(env, ['', `**${msg}**`]);
    } else {
      writeSummary(env, ['', `${files.length} selected viewer test file(s) passed.`]);
    }
    // Advisory: see the header for why a failure must not fail the Test run.
    return 0;
  }
  const decision = decideViewerSelect({
    mode: env.CI_PR_VIEWER_SELECT, event: env.GITHUB_EVENT_NAME, lane: env.LANE, headRef: env.HEAD_REF, noop: env.NOOP,
  });
  if (decision.warning) console.log(`::warning::${decision.warning}`);
  console.log(`[ci-viewer-select] mode=${decision.mode} select=${decision.select}: ${decision.reason}`);
  if (!decision.select) {
    writeSummary(env, summaryLines(decision));
    setOutputs(env, { run: 'false', count: 0, artifact: 'false' });
    return 0;
  }
  // HEAD is the PR's merge commit; its first parent is the base tip.
  const diff = execFileSync('git', ['diff', '--name-status', '--no-renames', '-z', 'HEAD^1', 'HEAD'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  const sel = computeSelection({ root, changes: parseNameStatus(diff) });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'selection.json'), `${JSON.stringify({
    pr: env.PR_NUMBER ?? null, headSha: env.HEAD_SHA ?? null, mergeSha: env.GITHUB_SHA ?? null, mode: decision.mode, ...sel,
  }, null, 2)}\n`);
  writeFileSync(join(dir, 'files.txt'), sel.ran.map((p) => `${local(p)}\n`).join(''));
  const lines = summaryLines(decision, sel);
  for (const l of lines) console.log(l);
  writeSummary(env, lines);
  setOutputs(env, { run: String(decision.runTests && sel.ran.length > 0), count: sel.ran.length, artifact: 'true' });
  return 0;
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`[ci-viewer-select] ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}
