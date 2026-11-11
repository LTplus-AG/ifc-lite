#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CI WASM build cache: decides whether a run may reuse the WASM build output
 * made for the same inputs, and checks that reuse when it is cheap to.
 *
 * The switch is the repository variable CI_WASM_CACHE:
 *   off     (unset, or any value but the two below) the old build steps:
 *           build from source, no restore, no save.
 *   shadow  restore AND build from source, compare the two byte for byte,
 *           annotate a mismatch, use the fresh build.
 *   on      a pull_request run uses the restored output on a hit and builds
 *           on a miss. Every other run (push, merge_group, workflow_dispatch,
 *           a Mergify batch PR) still builds from source and compares, so
 *           drift shows at one build per merge.
 * In either mode only runs on main save (planDecision says why).
 *
 * The key is a digest of the git object id of every path in
 * scripts/wasm-build-inputs.txt (the list the prebuilt-eligibility probe and
 * vercel-install.sh read too), the files committed under the output dirs,
 * the env vars the build reads (KEY_ENV_*), and the runner OS/arch. The build
 * commands live in scripts/ci-wasm-build.sh, which is on that list. Fails
 * closed: any error while planning turns the cache off for that run; a
 * restored entry is used only when every file matches the manifest stored
 * with it.
 *
 * Subcommands (plan and resolve append `name=value` lines to $GITHUB_OUTPUT
 * themselves; stdout is for annotations):
 *   plan     env CI_WASM_CACHE, GITHUB_EVENT_NAME, GITHUB_REF, PR_BATCH,
 *            GITHUB_WORKFLOW_REF, GITHUB_REPOSITORY
 *            -> mode, active, verify, store, key, paths
 *            Off for the run when the calling workflow's build step is not
 *            exactly `bash scripts/ci-wasm-build.sh` (lib/ci-wasm-build-step.mjs)
 *   resolve  env WASM_CACHE_VERIFY, WASM_CACHE_STORE, WASM_CACHE_KEY,
 *            WASM_CACHE_HIT -> build, compare, save, rejected
 *   clean    reset the output dirs to the checkout before a fresh build
 *   record   env WASM_CACHE_KEY: write the manifest of the fresh build;
 *            refuses when the env differs from what Plan keyed
 *   compare  env WASM_CACHE_MODE [--strict]: restored vs fresh; with
 *            --strict a mismatch fails when the mode is `on`
 *   published-paths  the listed paths the npm bundle depends on, one per
 *            line: the parser for the prebuilt-eligibility probes
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { buildStepProblems, workflowPath } from './lib/ci-wasm-build-step.mjs';
import { readInputList } from './lib/wasm-build-inputs.mjs';
import { envLines, envDrift } from './lib/ci-wasm-key-env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Bump to orphan every existing entry (e.g. after a drift report). */
export const KEY_VERSION = 'v1';
export const OUTPUT_DIRS = [
  'packages/wasm/pkg',
  'packages/wasm/pkg-diff',
  'packages/wasm/pkg-rhino',
  'packages/wasm/pkg-diff-decode-test',
];
const MANIFEST_DIR = '.ci-wasm-cache';
export const MANIFEST = `${MANIFEST_DIR}/manifest.json`;
export const CACHE_PATHS = [...OUTPUT_DIRS, MANIFEST_DIR];
/** A record without these is not a build, whatever else it holds. */
export const REQUIRED_OUTPUTS = [
  'packages/wasm/pkg/ifc-lite_bg.wasm',
  'packages/wasm/pkg/ifc-lite.js',
  'packages/wasm/pkg/ifc-lite.d.ts',
  'packages/wasm/pkg-diff/ifc-lite-diff_bg.wasm',
  'packages/wasm/pkg-diff/ifc-lite-diff.js',
  'packages/wasm/pkg-diff/ifc-lite-diff.d.ts',
  'packages/wasm/pkg-rhino/ifc-lite-rhino_bg.wasm',
  'packages/wasm/pkg-rhino/ifc-lite-rhino.js',
  'packages/wasm/pkg-rhino/ifc-lite-rhino.d.ts',
  'packages/wasm/pkg-diff-decode-test/ifc-lite-diff_bg.wasm',
  'packages/wasm/pkg-diff-decode-test/ifc-lite-diff.js',
];

export function normalizeMode(raw) {
  return raw === 'shadow' || raw === 'on' ? raw : 'off';
}

/**
 * Before the restore. `verify` runs always build from source; only an `on`
 * pull_request run (not a Mergify batch) may skip the build. `store`: only
 * main saves. Every PR reads main's entries; nothing reads merge_group or
 * batch-PR entries; and a PR's own entry would only serve a later push with
 * the same inputs, which for a PR that changed them also trips the `rust`
 * filter, whose toolchain setup makes turbo rebuild the WASM anyway.
 */
export function planDecision({ mode, event, batch, ref }) {
  const active = mode !== 'off';
  const verify = active && (mode === 'shadow' || event !== 'pull_request' || batch === 'true');
  const store = active && ref === 'refs/heads/main';
  return { active, verify, store };
}

/**
 * After the restore. `valid` means every restored file matched its manifest.
 * A hit that fails verification is never used and never overwritten (the key
 * exists); the run builds from source, and `rejected` lets main's strict
 * workflow fail on it.
 */
export function resolveDecision({ verify, store, hit, valid }) {
  const usable = hit && valid;
  const rejected = hit && !valid;
  const save = !hit && store;
  if (verify) return { build: true, compare: usable, save, rejected };
  return { build: !usable, compare: false, save, rejected };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * The text the key digests. Throws when a listed path does not exist at HEAD
 * (a typo would otherwise key on nothing) or differs from HEAD in the working
 * tree (the object id would not describe what gets built).
 */
export function inputManifest({ cwd, paths, env }) {
  const lines = [`version ${KEY_VERSION}`];
  for (const path of paths) {
    let oid;
    try {
      oid = git(cwd, ['rev-parse', '--verify', '--quiet', `HEAD:${path}`]);
    } catch {
      throw new Error(`input '${path}' does not exist at HEAD`);
    }
    lines.push(`path ${path} ${oid}`);
  }
  const dirty = git(cwd, ['status', '--porcelain', '--', ...paths]);
  if (dirty) throw new Error(`inputs differ from HEAD in the working tree:\n${dirty}`);
  // Committed files under the output dirs come back with every fresh build
  // (clean restores them), so they are part of what an entry must hold. Keyed
  // here, a newly tracked file starts a new entry instead of making every
  // restore of the old one fail verification.
  for (const line of git(cwd, ['ls-files', '-s', '--', ...OUTPUT_DIRS]).split('\n').filter(Boolean)) {
    lines.push(`tracked ${line}`);
  }
  lines.push(...envLines(env));
  return `${lines.join('\n')}\n`;
}

export function cacheKey(manifestText, env) {
  const digest = createHash('sha256').update(manifestText).digest('hex');
  return `wasm-build-${KEY_VERSION}-${env.RUNNER_OS ?? 'unknown'}-${env.RUNNER_ARCH ?? 'unknown'}-${digest}`;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
    else throw new Error(`${full}: not a regular file or directory`);
  }
}

/** sha256 of every file under OUTPUT_DIRS, keyed by repo-relative path. */
export function hashOutputs(cwd) {
  const files = {};
  for (const dir of OUTPUT_DIRS) {
    const abs = join(cwd, dir);
    if (!existsSync(abs)) throw new Error(`${dir} is missing`);
    const found = [];
    walk(abs, found);
    for (const file of found.sort()) {
      files[relative(cwd, file).split(sep).join('/')] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  }
  return files;
}

/** Paths whose hash differs or that exist on one side only. */
export function diffFiles(restored, fresh) {
  const paths = [...new Set([...Object.keys(restored), ...Object.keys(fresh)])].sort();
  return paths
    .filter((path) => restored[path] !== fresh[path])
    .map((path) => ({ path, restored: restored[path] ?? 'absent', fresh: fresh[path] ?? 'absent' }));
}

export function readManifest(cwd) {
  const manifest = JSON.parse(readFileSync(join(cwd, MANIFEST), 'utf-8'));
  if (typeof manifest?.key !== 'string' || typeof manifest?.files !== 'object' || manifest.files === null) {
    throw new Error(`${MANIFEST} is malformed`);
  }
  return manifest;
}

function requireOutputs(files, what) {
  const missing = REQUIRED_OUTPUTS.filter((path) => !(path in files));
  if (missing.length > 0) throw new Error(`${what} ${missing.join(', ')}`);
}

/**
 * Throws unless the restored tree is exactly what was recorded for `key`, and
 * holds what record requires today (an entry recorded under an older rule
 * passes its own manifest).
 */
export function verifyRestored(cwd, key) {
  const manifest = readManifest(cwd);
  if (manifest.key !== key) throw new Error(`manifest key ${manifest.key} != ${key}`);
  requireOutputs(manifest.files, 'entry lacks');
  const differences = diffFiles(manifest.files, hashOutputs(cwd));
  if (differences.length > 0) {
    throw new Error(`restored files differ from their manifest: ${differences.map((d) => d.path).join(', ')}`);
  }
  return manifest;
}

/**
 * packages/wasm/pkg* dirs the build wrote that OUTPUT_DIRS does not name.
 * A dir holding only tracked files (pkg-retained's committed .d.ts) is not
 * build output. Anything else would be left out of the entry and missing on
 * every hit, so recording refuses.
 */
export function unlistedOutputDirs(cwd) {
  const wasm = join(cwd, 'packages', 'wasm');
  if (!existsSync(wasm)) return [];
  const tracked = new Set(git(cwd, ['ls-files', '--', 'packages/wasm']).split('\n').filter(Boolean));
  const unlisted = [];
  for (const entry of readdirSync(wasm, { withFileTypes: true })) {
    const dir = `packages/wasm/${entry.name}`;
    if (!entry.isDirectory() || !entry.name.startsWith('pkg') || OUTPUT_DIRS.includes(dir)) continue;
    const found = [];
    walk(join(cwd, dir), found);
    if (found.some((file) => !tracked.has(relative(cwd, file).split(sep).join('/')))) unlisted.push(dir);
  }
  return unlisted;
}

export function recordOutputs(cwd, key) {
  if (!key) throw new Error('no cache key to record against');
  const unlisted = unlistedOutputDirs(cwd);
  if (unlisted.length > 0) {
    throw new Error(`the build wrote ${unlisted.join(', ')}, which OUTPUT_DIRS in scripts/ci-wasm-cache.mjs does not cache`);
  }
  const files = hashOutputs(cwd);
  requireOutputs(files, 'build output is missing');
  mkdirSync(join(cwd, MANIFEST_DIR), { recursive: true });
  writeFileSync(join(cwd, MANIFEST), `${JSON.stringify({ key, files }, null, 2)}\n`);
  return files;
}

/** Back to the checkout: drop the output dirs, restore their tracked files. */
export function cleanOutputs(cwd) {
  for (const path of CACHE_PATHS) rmSync(join(cwd, path), { recursive: true, force: true });
  const tracked = git(cwd, ['ls-files', '--', ...OUTPUT_DIRS]).split('\n').filter(Boolean);
  if (tracked.length > 0) git(cwd, ['checkout', '--', ...tracked]);
}

/**
 * Step outputs go straight to the $GITHUB_OUTPUT file (stdout when it is not
 * set, for local use). Never redirect this script's stdout into that file:
 * stdout carries the `::warning` annotations, and redirected they turn into
 * bogus outputs and never show.
 */
function emit(outputs) {
  let text = '';
  for (const [name, value] of Object.entries(outputs)) {
    const v = String(value);
    text += v.includes('\n') ? `${name}<<__WASM_CACHE_EOF__\n${v}\n__WASM_CACHE_EOF__\n` : `${name}=${v}\n`;
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}

function summary(line) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

/** The env Plan keyed on, for `record` to compare with the env the build ran in. */
function planEnvFile(env) {
  return join(env.RUNNER_TEMP ?? tmpdir(), 'wasm-cache-plan-env.txt');
}

function restoredCopy(env) {
  return join(env.RUNNER_TEMP ?? tmpdir(), 'wasm-cache-restored.json');
}

function plan(env) {
  const mode = normalizeMode(env.CI_WASM_CACHE ?? '');
  try {
    const { active, verify, store } = planDecision({ mode, event: env.GITHUB_EVENT_NAME, batch: env.PR_BATCH, ref: env.GITHUB_REF });
    if (!active) return emit({ mode, active: false, verify: false });
    const problems = buildStepProblems(readFileSync(join(ROOT, workflowPath(env)), 'utf-8'));
    if (problems.length > 0) throw new Error(`the WASM build step is not keyable: ${problems.join('; ')}`);
    const manifest = inputManifest({ cwd: ROOT, paths: readInputList(ROOT), env });
    const key = cacheKey(manifest, env);
    writeFileSync(planEnvFile(env), `${envLines(env).join('\n')}\n`);
    console.error(`WASM build cache key ${key}, digest of:\n${manifest}`);
    emit({ mode, active: true, verify, store, key, paths: CACHE_PATHS.join('\n') });
  } catch (error) {
    console.log(`::warning title=WASM build cache off for this run::${error.message.split('\n')[0]}`);
    console.error(error.message);
    emit({ mode, active: false, verify: false });
  }
}

function resolve(env) {
  const verify = env.WASM_CACHE_VERIFY === 'true';
  const store = env.WASM_CACHE_STORE === 'true';
  const hit = env.WASM_CACHE_HIT === 'true';
  try {
    let valid = false;
    if (hit) {
      try {
        verifyRestored(ROOT, env.WASM_CACHE_KEY);
        copyFileSync(join(ROOT, MANIFEST), restoredCopy(env));
        valid = true;
      } catch (error) {
        console.log(`::warning title=WASM build cache entry rejected::${error.message}; building from source`);
      }
    }
    const decision = resolveDecision({ verify, store, hit, valid });
    const use = decision.build ? 'built from source' : 'restored output used';
    summary(`WASM build cache: mode=${env.WASM_CACHE_MODE} ${hit ? (valid ? 'hit' : 'hit-rejected') : 'miss'}, ${use}`);
    emit(decision);
  } catch (error) {
    console.log(`::warning title=WASM build cache resolve failed::${error.message}; building from source`);
    emit({ build: true, compare: false, save: false, rejected: false });
  }
}

function compare(env, strict) {
  const restored = JSON.parse(readFileSync(restoredCopy(env), 'utf-8'));
  const fresh = readManifest(ROOT);
  const differences = diffFiles(restored.files, fresh.files);
  if (differences.length === 0) {
    console.log(`Restored WASM cache entry matches the fresh build byte for byte (${Object.keys(fresh.files).length} files).`);
    summary('WASM build cache: restored entry identical to the fresh build');
    return 0;
  }
  const level = env.WASM_CACHE_MODE === 'on' ? 'error' : 'warning';
  for (const d of differences) console.error(`  ${d.path}: restored ${d.restored} fresh ${d.fresh}`);
  console.log(
    `::${level} title=WASM build cache drift::${differences.length} file(s) differ between the cache entry and a fresh build ` +
      `of the same inputs (${differences.slice(0, 5).map((d) => d.path).join(', ')}). The key misses an input or the build ` +
      `is not reproducible here. Set CI_WASM_CACHE to off or shadow, then delete the entry: gh cache delete ${fresh.key}`,
  );
  summary(`WASM build cache: DRIFT in ${differences.length} file(s)`);
  return strict && env.WASM_CACHE_MODE === 'on' ? 1 : 0;
}

if (isMainEntry(import.meta.url)) {
  const [command, flag] = process.argv.slice(2);
  const env = process.env;
  if (command === 'plan') plan(env);
  else if (command === 'resolve') resolve(env);
  else if (command === 'published-paths') {
    try {
      process.stdout.write(`${readInputList(ROOT, { published: true }).join('\n')}\n`);
    } catch (error) {
      console.error(`ci-wasm-cache.mjs: ${error.message}`);
      process.exitCode = 1;
    }
  }
  else if (command === 'clean') cleanOutputs(ROOT);
  else if (command === 'record') {
    // A step between Plan and the build can change the build's env through
    // $GITHUB_ENV, which the key never saw; such a build is not recorded.
    try {
      const drift = envDrift(readFileSync(planEnvFile(env), 'utf-8'), env);
      if (drift.length > 0) throw new Error(`build env differs from what Plan keyed: ${drift.join('; ')}`);
      const files = recordOutputs(ROOT, env.WASM_CACHE_KEY ?? '');
      console.log(`Recorded ${Object.keys(files).length} WASM output files for ${env.WASM_CACHE_KEY}`);
    } catch (error) {
      console.log(`::warning title=WASM build cache entry not recorded::${error.message}`);
      process.exitCode = 1;
    }
  } else if (command === 'compare') process.exitCode = compare(env, flag === '--strict');
  else {
    console.error('usage: ci-wasm-cache.mjs plan|resolve|clean|record|compare [--strict]|published-paths');
    process.exitCode = 2;
  }
}
