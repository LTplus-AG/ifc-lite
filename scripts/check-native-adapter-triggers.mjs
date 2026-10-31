#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guard: the SMLib `native-adapter` lane must trigger on everything the
 * retained engine compiles from, and must guard `main` (#7955).
 *
 * The lane (`.github/workflows/geometry-platform.yml`) qualifies retained
 * parity. A hand-maintained exact-path filter missed shared code the retained
 * engine consumes (`rust/geometry/src/processors`, `rust/core`,
 * `rust/processing/src/style`), so an exact-engine refactor could break
 * retained parity unseen. This derives the required crate directories from the
 * Cargo manifests -- the transitive path-dependency closure (normal, dev and
 * build dependencies) of the lane's root crates -- and fails when:
 *
 *   - a crate directory in that closure is not covered by
 *     `on.pull_request.paths` or `on.push.paths`;
 *   - the push and pull_request path lists differ (they must not drift);
 *   - the workflow has no push-to-main trigger or no nightly `schedule`;
 *   - the nightly run does not carry the corpus, or the main/nightly red
 *     runs have no reporter job (or the green-again closer is gone);
 *   - the concurrency group would run main pushes unthrottled, or cancel an
 *     in-flight main run;
 *   - a corpus step is not independent (`continue-on-error`) of the steps after it.
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
    const named = line.match(/^([A-Za-z0-9_-]+)(?:\.workspace\s*=\s*true|\s*=\s*(.*))/);
    if (!isDep || !named) continue;
    const spec = named[2] ?? '';
    if (spec.trim().startsWith('{') && !spec.includes('}')) {
      throw new Error(`${crateDir}/Cargo.toml: multi-line inline table for ${named[1]} is not parsed; keep it on one line`);
    }
    const path = spec.match(/\bpath\s*=\s*"([^"]+)"/);
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
    const open = inSection && line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{(?!.*\})/);
    if (open) throw new Error(`Cargo.toml: multi-line inline table for workspace dependency ${open[1]} is not parsed; keep it on one line`);
    const m = inSection && line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{.*\bpath\s*=\s*"([^"]+)"/);
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
  if (!/^ {8}if: always\(\)\s*\n(?:[\s\S]*?)check-retained-corpus-summary\.mjs "\$RUNNER_TEMP\/native-corpus\/summary\.json"/m.test(corpus)) {
    out.push(`${WORKFLOW}: every shard must judge its summary.json in an if: always() step`);
  }
  if (result !== null) {
    if (!/^ {4}needs: \[native-corpus\]\s*$/m.test(result)) out.push(`${WORKFLOW}: native-corpus-result must need native-corpus`);
    if (!/^ {4}if: always\(\) && /m.test(result)) out.push(`${WORKFLOW}: native-corpus-result must run if: always() so a failed shard still reports`);
    const agg = result.match(/check-retained-corpus-summary\.mjs --shards (\d+) /);
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
  let push;
  try {
    pr = eventPaths(text, 'pull_request');
    push = eventPaths(text, 'push');
  } catch (err) {
    return [`${WORKFLOW}: ${err.message}`];
  }
  if (!pr || pr.length === 0) failures.push(`${WORKFLOW}: on.pull_request.paths is missing`);
  if (!push || push.length === 0) failures.push(`${WORKFLOW}: on.push.paths is missing (the lane must guard main)`);
  if (!/^ {2}push:\s*\n\s+branches:\s*\[main\]/m.test(text)) failures.push(`${WORKFLOW}: on.push must be limited to branches: [main]`);
  if (!/^ {2}schedule:\s*\n\s+- cron: '/m.test(text)) failures.push(`${WORKFLOW}: on.schedule (nightly corpus run) is missing`);

  if (pr && push) {
    const missing = pr.filter((p) => !push.includes(p));
    const extra = push.filter((p) => !pr.includes(p));
    for (const p of missing) failures.push(`${WORKFLOW}: path ${p} is in pull_request.paths but not push.paths`);
    for (const p of extra) failures.push(`${WORKFLOW}: path ${p} is in push.paths but not pull_request.paths`);
  }

  let closure;
  try {
    closure = crateClosure(root);
  } catch (err) {
    return [...failures, `${err.message}`];
  }
  for (const [name, globs] of [['pull_request', pr], ['push', push]]) {
    if (!globs) continue;
    for (const dir of closure) {
      // The literal directory glob, not probe files: `<dir>/Cargo.toml` + `<dir>/src/lib.rs` entries would
      // satisfy probes and still leave the rest of the crate unable to trigger the lane.
      if (!globs.includes(`${dir}/**`)) {
        failures.push(`${WORKFLOW}: crate ${dir} (in the retained engine's dependency closure) is not covered by on.${name}.paths -- add '${dir}/**'`);
      }
    }
    for (const extra of EXTRA_GLOBS) {
      const probe = extra.replace('/**', '/probe');
      if (!matchesAny(probe, globs)) failures.push(`${WORKFLOW}: ${extra} is not covered by on.${name}.paths`);
    }
  }

  for (const action of new Set([...text.matchAll(/^\s*(?:-\s*)?uses:\s*\.\/(\.github\/actions\/[^/\s]+)/gm)].map((m) => m[1]))) {
    for (const [name, globs] of [['pull_request', pr], ['push', push]]) {
      if (globs && !globs.includes(`${action}/**`)) failures.push(`${WORKFLOW}: local action ${action} is called by the job but not covered by on.${name}.paths -- add '${action}/**'`);
    }
  }
  failures.push(...corpusJobProblems(text));
  if (!/^concurrency:\s*\n {2}group: native-adapter-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}\s*\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\s*$/m.test(text)) {
    failures.push(`${WORKFLOW}: top-level concurrency must group by event and ref and cancel only pull_request runs (main pushes would run unthrottled, or an in-flight main run would be cancelled)`);
  }
  if (!/github\.ref == 'refs\/heads\/main' && needs\.native-adapter\.result == 'failure'/.test(text)) failures.push(`${WORKFLOW}: report-red-on-main must fire on 'failure' only; a cancelled (superseded) run is not red`);
  if ((text.match(/is not main's head/g) ?? []).length < 2) failures.push(`${WORKFLOW}: both main reporters must ignore a stale rerun (compare github.sha with main's head before touching the issue)`);
  if (!/^ {2}close-red-on-main:/m.test(text)) failures.push(`${WORKFLOW}: no close-red-on-main job; the issue would stay open after main is green`);
  if (!/^ {2}report-red-on-main:/m.test(text)) failures.push(`${WORKFLOW}: no report-red-on-main job for a failing push to main`);
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
  console.log(`✅ check-native-adapter-triggers: ${crateClosure(root).length} crates covered; main and nightly guarded`);
}
