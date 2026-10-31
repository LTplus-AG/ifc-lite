#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guard: the SMLib `native-adapter` lane triggers on everything the retained
 * engine compiles from, and keeps its cost controls (#7955, #8460).
 *
 * The lane (`.github/workflows/geometry-platform.yml`) qualifies retained
 * parity. It holds a hosted runner for about an hour, so it does NOT run on
 * every push or PR: nightly (main's guard, with the corpus), on demand, and on
 * a PR only with the `ci:native-adapter` label. A hand-maintained exact-path
 * filter missed shared code the retained engine consumes
 * (`rust/geometry/src/processors`, `rust/core`, `rust/processing/src/style`),
 * so a labelled PR could pass without observing a change that breaks retained
 * parity. This derives the required crate directories from the Cargo manifests
 * -- the transitive path-dependency closure (normal, dev and build
 * dependencies) of the lane's root crates -- and fails when:
 *
 *   - a crate directory in that closure, a non-crate Rust input, or a local
 *     action the job calls is not covered by `on.pull_request.paths`;
 *   - the workflow triggers on push, has no nightly `schedule`, or loses the
 *     opt-in label `if`, the `labeled` type or the job-level per-PR concurrency;
 *   - the corpus is not its own scheduled/dispatch-only, sharded, bounded,
 *     judged job with a required aggregate, or the nightly failure reporter
 *     does not cover it.
 *
 * Manifests are parsed by hand, so a shape this parser cannot read throws
 * (`[dependencies.foo]` sub-tables, multi-line inline tables) rather than
 * silently shrinking the closure.
 *
 * `--root <dir>` points it at a mutated copy of the tree (see the test).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesAny } from './lib/ci-path-coverage.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const WORKFLOW = '.github/workflows/geometry-platform.yml';
/** Crates the lane builds or drives: the native consumer and the browser worker's wasm crate. */
export const ROOT_CRATES = ['rust/retained-native', 'rust/wasm-bindings'];
/** Non-crate inputs every Rust build of the lane reads. */
export const EXTRA_GLOBS = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo/**'];

const DEP_SECTION = /^\[(?:target\.[^\]]+\.)?(?:dev-|build-)?dependencies\]$/;

/** Path deps of one manifest as repo-relative crate dirs. Workspace-inherited deps resolve through `workspace`. */
export function pathDeps(manifestText, crateDir, workspace) {
  const found = new Set();
  let section = '';
  for (const raw of manifestText.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '') continue;
    const header = line.match(/^\[.*\]$/);
    if (header) {
      if (/^\[(?:target\.[^\]]+\.)?(?:workspace\.|dev-|build-)?dependencies\.[^\]]+\]$/.test(line)) {
        throw new Error(`${crateDir}/Cargo.toml: dependency sub-table ${line} is not parsed; write it as an inline table`);
      }
      section = line;
      continue;
    }
    const isDep = DEP_SECTION.test(section) || section === '[workspace.dependencies]';
    if (isDep) {
      const dotted = line.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*=/);
      if (dotted && dotted[2] !== 'workspace') throw new Error(`${crateDir}/Cargo.toml: dotted key ${dotted[1]}.${dotted[2]} is not parsed; write ${dotted[1]} as an inline table`);
    }
    const named = line.match(/^([A-Za-z0-9_-]+)(?:\.workspace\s*=\s*true|\s*=\s*(.*))/);
    if (!isDep || !named) continue;
    const spec = named[2] ?? '';
    if (spec.trim().startsWith('{') && !spec.includes('}')) {
      throw new Error(`${crateDir}/Cargo.toml: multi-line inline table for ${named[1]} is not parsed; keep it on one line`);
    }
    const path = spec.match(/\bpath\s*=\s*["']([^"']+)["']/);
    if (path) found.add(posix.normalize(posix.join(crateDir, path[1])));
    else if (section !== '[workspace.dependencies]' && (named[2] === undefined || /\bworkspace\s*=\s*true/.test(spec))) {
      const via = workspace.get(named[1]);
      if (via) found.add(via);
    }
  }
  return found;
}

export function workspaceDeps(rootManifestText) {
  const map = new Map();
  let inSection = false;
  for (const raw of rootManifestText.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (/^\[.*\]$/.test(line)) {
      if (/^\[workspace\.dependencies\.[^\]]+\]$/.test(line)) {
        throw new Error(`Cargo.toml: ${line} is not parsed; write it as an inline table under [workspace.dependencies]`);
      }
      inSection = line === '[workspace.dependencies]';
      continue;
    }
    const dotted = inSection && line.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*=/);
    if (dotted) throw new Error(`Cargo.toml: dotted key ${dotted[1]}.${dotted[2]} under [workspace.dependencies] is not parsed; write ${dotted[1]} as an inline table`);
    const open = inSection && line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{(?!.*\})/);
    if (open) throw new Error(`Cargo.toml: multi-line inline table for workspace dependency ${open[1]} is not parsed; keep it on one line`);
    const m = inSection && line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{.*\bpath\s*=\s*["']([^"']+)["']/);
    if (m) map.set(m[1], posix.normalize(m[2]));
  }
  return map;
}

/** Transitive crate-directory closure of `roots`. */
export function crateClosure(root, roots = ROOT_CRATES) {
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  const workspace = workspaceDeps(read('Cargo.toml'));
  const seen = new Set();
  const visit = (dir) => {
    if (seen.has(dir)) return;
    const manifest = `${dir}/Cargo.toml`;
    if (!existsSync(join(root, manifest))) throw new Error(`${manifest} does not exist (path dependency of the native-adapter closure)`);
    seen.add(dir);
    for (const dep of pathDeps(read(manifest), dir, workspace)) visit(dep);
  };
  for (const r of roots) visit(r);
  return [...seen].sort();
}

/** `on.<event>.paths` block list, or null when the event or list is absent. */
export function eventPaths(text, event) {
  const lines = text.split('\n');
  const onAt = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (onAt === -1) return null;
  let inEvent = false;
  let inPaths = false;
  let paths = null;
  for (let i = onAt + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^\S/.test(raw)) break;
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    if (/^ {2}\S/.test(raw)) { inEvent = raw.startsWith(`  ${event}:`); inPaths = false; continue; }
    if (!inEvent) continue;
    if (/^ {4}paths:\s*$/.test(raw)) { inPaths = true; paths = []; continue; }
    if (/^ {4}\S/.test(raw)) { inPaths = false; continue; }
    if (inPaths) {
      const m = raw.trim().match(/^-\s*'([^']+)'$/);
      if (!m) throw new Error(`unparseable on.${event}.paths entry ${JSON.stringify(raw.trim())}`);
      paths.push(m[1]);
    }
  }
  return paths;
}

const CORPUS_IF = "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.corpus == true)";

/** Text of one top-level job (from `  id:` to the next two-space key). */
export function jobBlock(text, id) {
  const m = text.match(new RegExp(`^ {2}${id}:\\n([\\s\\S]*?)(?=^ {2}[A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`, 'm'));
  return m ? m[1] : null;
}

/** The downloaded corpus lives in its own scheduled/dispatch job, sharded, with a required aggregate. */
export function corpusJobProblems(text) {
  const out = [];
  const corpus = jobBlock(text, 'native-corpus');
  const result = jobBlock(text, 'native-corpus-result');
  const main = jobBlock(text, 'native-adapter');
  if (corpus === null) return [`${WORKFLOW}: no native-corpus job; the nightly corpus must not run inside native-adapter`];
  if (result === null) out.push(`${WORKFLOW}: no native-corpus-result aggregate job over the shards`);
  if (main !== null && /--manifest tests\/models\/manifest/.test(main)) out.push(`${WORKFLOW}: native-adapter runs the corpus itself; it belongs in the native-corpus job`);
  if (new RegExp(`^ {4}if: ${CORPUS_IF.replace(/[().|=&']/g, '\\$&')}\\s*$`, 'm').test(corpus) === false) out.push(`${WORKFLOW}: native-corpus must be gated on exactly: ${CORPUS_IF}`);
  const budget = corpus.match(/^ {4}timeout-minutes: (\d+)\s*$/m);
  if (!budget || Number(budget[1]) > 360) out.push(`${WORKFLOW}: native-corpus needs a literal timeout-minutes within GitHub's 360-minute limit`);
  if (!/^ {6}fail-fast: false\s*$/m.test(corpus)) out.push(`${WORKFLOW}: native-corpus matrix must set fail-fast: false so one slow shard does not hide the others`);
  const matrix = corpus.match(/^ {8}shard: \[([0-9, ]+)\]\s*$/m);
  const shards = matrix ? matrix[1].split(',').map((s) => Number(s.trim())) : [];
  if (shards.length === 0 || shards.some((s, i) => s !== i)) out.push(`${WORKFLOW}: native-corpus matrix shard must list 0..N-1 in order`);
  const select = corpus.match(/corpus-shards\.mjs shard [^\n]*--shards (\d+)/);
  if (!select || Number(select[1]) !== shards.length) out.push(`${WORKFLOW}: the shard selection step's --shards must equal the matrix size (${shards.length})`);
  const compare = corpus.match(/id: compare\n([\s\S]*?)\n {6}(?:# |- )/);
  if (!compare || !/^ {8}continue-on-error: true[ \t]*$/m.test(compare[1]) || !/^ {8}timeout-minutes: \d+[ \t]*$/m.test(compare[1])) {
    out.push(`${WORKFLOW}: the corpus comparison step needs continue-on-error and its own timeout-minutes so a timeout is judged, not fatal`);
  }
  // `(?!^ {6}- )` stops the lazy match at the next step, so an earlier step's `if: always()` cannot satisfy it.
  if (!/^ {8}if: always\(\)\s*\n(?:(?!^ {6}- )[\s\S])*?check-retained-corpus-summary\.mjs --report-violations "\$RUNNER_TEMP\/native-corpus\/summary\.json"/m.test(corpus)) {
    out.push(`${WORKFLOW}: every shard must judge its summary.json in an if: always() step`);
  }
  if (result !== null) {
    if (!/^ {4}needs: \[native-corpus\]\s*$/m.test(result)) out.push(`${WORKFLOW}: native-corpus-result must need native-corpus`);
    if (!/^ {4}if: always\(\) && /m.test(result)) out.push(`${WORKFLOW}: native-corpus-result must run if: always() so a failed shard still reports`);
    const agg = result.match(/check-retained-corpus-summary\.mjs --shards (\d+) --report-violations /);
    if (!agg || Number(agg[1]) !== shards.length) out.push(`${WORKFLOW}: native-corpus-result must require exactly the matrix's ${shards.length} shard summaries`);
    if (!/\[\[ "\$SHARDS_RESULT" == success \]\]/.test(result)) out.push(`${WORKFLOW}: native-corpus-result must fail when the matrix result is not success`);
  }
  const reporter = jobBlock(text, 'report-scheduled-failure');
  if (reporter !== null && !/^ {4}needs: \[native-adapter, native-corpus-result\]\s*$/m.test(reporter)) out.push(`${WORKFLOW}: report-scheduled-failure must need native-corpus-result so a corpus failure is reported`);
  const browser = jobBlock(text, 'browser-corpus');
  if (browser === null || !/^ {4}continue-on-error: true\s*$/m.test(browser)) out.push(`${WORKFLOW}: browser-corpus must exist and stay report-only (job-level continue-on-error)`);
  return out;
}

export function audit(root) {
  const failures = [];
  const wfPath = join(root, WORKFLOW);
  if (!existsSync(wfPath)) return [`${WORKFLOW} is missing`];
  const text = readFileSync(wfPath, 'utf8');

  let pr;
  try {
    pr = eventPaths(text, 'pull_request');
  } catch (err) {
    return [`${WORKFLOW}: ${err.message}`];
  }
  if (!pr || pr.length === 0) failures.push(`${WORKFLOW}: on.pull_request.paths is missing`);
  // #8460: the lane is too costly per push; nightly is main's guard, labelled PRs are the opt-in.
  if (/^ {2}push:/m.test(text.slice(0, text.indexOf('\njobs:')))) failures.push(`${WORKFLOW}: must not trigger on push; the nightly schedule guards main (#8460)`);
  if (!/^ {2}schedule:\s*\n\s+- cron: '/m.test(text)) failures.push(`${WORKFLOW}: on.schedule (the nightly guard for main, with the corpus) is missing`);

  // The opt-in label gate must not silently vanish (it would put the lane back on every PR).
  const mainJob = jobBlock(text, 'native-adapter') ?? '';
  if (!/^ {4}if: >-\s*\n\s+github\.event_name != 'pull_request' \|\|\s*\n\s+\(contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci:native-adapter'\) &&\s*\n\s+\(github\.event\.action != 'labeled' \|\| github\.event\.label\.name == 'ci:native-adapter'\)\)\s*$/m.test(mainJob)) {
    failures.push(`${WORKFLOW}: the native-adapter job must keep its opt-in gate: non-PR events run, a PR only with the ci:native-adapter label (and only that label's event restarts it)`);
  }
  if (!/^ {4}types: \[[^\]]*\blabeled\b[^\]]*\]\s*$/m.test(text.slice(text.indexOf('  pull_request:'), text.indexOf('  schedule:')))) {
    failures.push(`${WORKFLOW}: on.pull_request.types must include labeled so applying the label starts the job`);
  }
  // Job level (#8460): a workflow-level group lets a skipped run cancel the running qualification.
  if (/^concurrency:/m.test(text)) failures.push(`${WORKFLOW}: concurrency must be set on the native-adapter job, not the workflow (a skipped run would cancel a running one)`);
  if (!/^ {4}concurrency:\s*\n {6}group: geometry-platform-\$\{\{ github\.event\.pull_request\.number \|\| github\.run_id \}\}\s*\n {6}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\s*$/m.test(mainJob)) {
    failures.push(`${WORKFLOW}: the native-adapter job's concurrency must be per-PR with cancel-in-progress only for pull_request runs; nightly and manual runs are never cancelled`);
  }

  let closure;
  try {
    closure = crateClosure(root);
  } catch (err) {
    return [...failures, `${err.message}`];
  }
  if (pr) {
    for (const dir of closure) {
      // The literal directory glob, not probe files: `<dir>/Cargo.toml` + `<dir>/src/lib.rs` entries would
      // satisfy probes and still leave the rest of the crate unable to trigger the lane.
      if (!pr.includes(`${dir}/**`)) {
        failures.push(`${WORKFLOW}: crate ${dir} (in the retained engine's dependency closure) is not covered by on.pull_request.paths -- add '${dir}/**'`);
      }
    }
    for (const extra of EXTRA_GLOBS) {
      const probe = extra.replace('/**', '/probe');
      if (!matchesAny(probe, pr)) failures.push(`${WORKFLOW}: ${extra} is not covered by on.pull_request.paths`);
    }
    for (const action of new Set([...text.matchAll(/^\s*(?:-\s*)?uses:\s*\.\/(\.github\/actions\/[^/\s]+)/gm)].map((m) => m[1]))) {
      if (!pr.includes(`${action}/**`)) failures.push(`${WORKFLOW}: local action ${action} is called by the job but not covered by on.pull_request.paths -- add '${action}/**'`);
    }
  }

  if (pr) {
    // Every script the lane runs, and what those scripts import, must be able to trigger it.
    const queue = [...new Set([...text.matchAll(/\bnode (scripts\/[\w./-]+\.mjs)/g)].map((m) => m[1]))];
    const seen = new Set();
    while (queue.length > 0) {
      const script = queue.pop();
      if (seen.has(script)) continue;
      seen.add(script);
      if (!matchesAny(script, pr)) failures.push(`${WORKFLOW}: ${script} is run by (or imported by a script run by) the job but is not covered by on.pull_request.paths`);
      if (!existsSync(join(root, script))) continue;
      for (const m of readFileSync(join(root, script), 'utf8').matchAll(/from '(\.{1,2}\/[^']+\.mjs)'/g)) {
        const next = posix.normalize(posix.join(posix.dirname(script), m[1]));
        if (next.startsWith('scripts/')) queue.push(next);
      }
    }
  }
  const browser = jobBlock(text, 'browser-corpus');
  if (browser !== null && !/pnpm fixtures[\s\S]*browser\.mjs/.test(browser)) failures.push(`${WORKFLOW}: browser-corpus must download the corpus (pnpm fixtures) before comparing; the checkout does not hold the models`);
  failures.push(...corpusJobProblems(text));
  if (!/^ {2}report-scheduled-failure:/m.test(text)) failures.push(`${WORKFLOW}: no report-scheduled-failure job for a failing nightly run`);
  return failures;
}

if (isMainEntry(import.meta.url)) {
  const flag = process.argv.indexOf('--root');
  const root = flag !== -1 && process.argv[flag + 1] ? process.argv[flag + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
  const failures = audit(root);
  if (failures.length > 0) {
    console.error(`❌ check-native-adapter-triggers: ${failures.length} problem(s)\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`✅ check-native-adapter-triggers: ${crateClosure(root).length} crates covered; opt-in PR lane and nightly guard intact`);
}
