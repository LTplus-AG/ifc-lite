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
 *     runs have no reporter job.
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
    if (header) { section = line; continue; }
    const isDep = DEP_SECTION.test(section) || section === '[workspace.dependencies]';
    const named = line.match(/^([A-Za-z0-9_-]+)(?:\.workspace\s*=\s*true|\s*=\s*(.*))/);
    if (!isDep || !named) continue;
    const spec = named[2] ?? '';
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
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inSection = line === '[workspace.dependencies]'; continue; }
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
      if (!matchesAny(`${dir}/Cargo.toml`, globs) || !matchesAny(`${dir}/src/lib.rs`, globs)) {
        failures.push(`${WORKFLOW}: crate ${dir} (in the retained engine's dependency closure) is not covered by on.${name}.paths -- add '${dir}/**'`);
      }
    }
    for (const extra of EXTRA_GLOBS) {
      const probe = extra.replace('/**', '/probe');
      if (!matchesAny(probe, globs)) failures.push(`${WORKFLOW}: ${extra} is not covered by on.${name}.paths`);
    }
  }

  if (!/inputs\.corpus == true \|\| github\.event_name == 'schedule'/.test(text)) {
    failures.push(`${WORKFLOW}: the corpus steps do not run on the scheduled event`);
  }
  if (/inputs\.corpus == true(?! \|\| github\.event_name == 'schedule')/.test(text)) {
    failures.push(`${WORKFLOW}: a corpus step is gated on inputs.corpus alone, so it never runs nightly`);
  }
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
