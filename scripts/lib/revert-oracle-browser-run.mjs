/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spawning half of the revert oracle's Playwright observer (#6267). The pure
 * half, and the rule for what counts as a browser observation, is
 * `revert-oracle-browser.mjs`.
 *
 * It reuses exactly what CI's viewer-e2e lane runs rather than a parallel
 * recipe: the root `build:e2e` script builds the viewer, the root
 * `test:e2e:ci` script (`playwright test --project=viewer-e2e-ci`) runs the
 * spec, and the Playwright config's own webServer serves the build. Each
 * measurement rebuilds, so the reverted side is served the reverted bundle.
 *
 * BOUNDS. Only the changed specs run, one scoped `playwright test <spec>` per
 * side, with a build timeout, a Playwright `--global-timeout` and a hard
 * process timeout behind it. The dispatcher runs these only when no cheaper
 * changed test has already observed the revert (`revert-oracle-measure.mjs`).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { claimRuntimeAdapter } from './revert-oracle-adapters.mjs';
import { BROWSER_BUILD_SCRIPT, BROWSER_TEST_SCRIPT, browserRunArgs, parsePlaywrightReport, reportTests } from './revert-oracle-browser.mjs';
import { resolveCommand } from './revert-oracle-run-plan.mjs';

const BUILD_TIMEOUT_MS = 8 * 60_000;
const LIST_TIMEOUT_MS = 2 * 60_000;
const GLOBAL_TIMEOUT_MS = 9 * 60_000;
const RUN_TIMEOUT_MS = GLOBAL_TIMEOUT_MS + 60_000;

export const BROWSER_PREREQUISITES =
  `browser prerequisites: a Chrome for the Playwright project's channel, the viewer built by the root \`${BROWSER_BUILD_SCRIPT}\` ` +
  'script (rebuilt on each side of the revert), and fixtures from `pnpm fixtures`. A test that skips for a missing ' +
  'fixture or GPU never counts as observation.';

/** Production paths a viewer rebuild cannot carry into the browser: the wasm runtime is not rebuilt here. */
const UNBUILT_IN_BROWSER = (path) => path.startsWith('rust/') || path.endsWith('.rs') || /(^|\/)Cargo\.(toml|lock)$/.test(path);

function rootScripts(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  } catch (error) {
    return { __error: error.message };
  }
}

const baseEnv = () => ({ ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' });

function sameFileAs(root, spec, report) {
  const expected = resolve(root, spec);
  const base = report?.config?.rootDir ?? root;
  return (file) => resolve(base, file) === expected;
}

function readJson(text) {
  const start = text.indexOf('{');
  return start === -1 ? null : JSON.parse(text.slice(start));
}

/**
 * Turn the changed Playwright specs into executable plans, or capability gaps
 * that name why a spec cannot be measured. A spec the CI project does not
 * select (the opt-in collab/appearance projects) is a gap, not a silent pass.
 */
export function planBrowserSpecs(specs, root, { prodPaths = [], log = console.log } = {}) {
  const plans = [], gaps = [];
  if (specs.length === 0) return { plans, gaps };
  const scripts = rootScripts(root);
  const claimed = claimRuntimeAdapter({ kind: 'playwright', scripts });
  const unbuilt = prodPaths.filter(UNBUILT_IN_BROWSER);
  const command = claimed && resolveCommand(claimed.runner.bin, root, root);
  for (const spec of specs) {
    if (!claimed) {
      gaps.push({ file: spec, reason: `no browser runner: the root package needs a \`${BROWSER_TEST_SCRIPT}\` script of the form \`playwright test ...\`${scripts.__error ? ` (${scripts.__error})` : ''}` });
    } else if (unbuilt.length > 0) {
      gaps.push({ file: spec, reason: `the browser observer rebuilds the viewer bundle, not the wasm runtime, so reverting ${unbuilt[0]} cannot reach the browser` });
    } else if (!command) {
      gaps.push({ file: spec, reason: 'the playwright binary was not found from the repository root; run pnpm install' });
    } else {
      const listed = spawnSync(command.bin, [...command.prefix, ...browserRunArgs(claimed.runner, spec, { list: true })], {
        cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: LIST_TIMEOUT_MS, env: baseEnv(),
      });
      let report = null;
      try {
        report = readJson(listed.stdout ?? '');
      } catch (error) {
        log(`  browser: could not read the Playwright listing for ${spec}: ${error.message}`);
      }
      const selected = reportTests(report).filter(({ file }) => sameFileAs(root, spec, report)(file));
      if (selected.length === 0) {
        gaps.push({ file: spec, reason: `\`${BROWSER_TEST_SCRIPT}\` (${claimed.runner.args.join(' ')}) selects no test in this spec, so the browser observer cannot run it (${listed.error?.message ?? `listing exit ${listed.status}`})` });
        continue;
      }
      plans.push({
        key: `playwright:${spec}`, file: spec, dir: root, files: [spec], relFiles: [spec], browser: true,
        adapter: claimed.adapter, runner: claimed.runner, script: scripts[BROWSER_TEST_SCRIPT], crate: null,
        listed: selected.length,
      });
    }
  }
  for (const plan of plans) {
    const build = plan.runner.build ? `${plan.runner.build.bin} ${plan.runner.build.args.join(' ')}` : 'none';
    log(`  browser: ${plan.file} -> ${plan.runner.bin} ${browserRunArgs(plan.runner, plan.file).join(' ')} (${plan.listed} test(s) listed; build: ${build})`);
  }
  if (plans.length > 0) log(`  ${BROWSER_PREREQUISITES}`);
  return { plans, gaps };
}

// The child writes the port as a STRING. `console.log(<number>)` colours a
// number whenever FORCE_COLOR is set in the inherited environment
// (`\x1b[33m59117\x1b[39m`), which `parseInt` reads as NaN (#7029).
function freePort() {
  const probe = spawnSync(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"], { encoding: 'utf8', timeout: 10_000 });
  const port = Number.parseInt(probe.stdout ?? '', 10);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`could not reserve a preview port: ${probe.error?.message ?? probe.stderr}`);
  return port;
}

const tailOf = (run) => `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n');

function finish(parsed, extra, started, plan, label, log) {
  Object.assign(parsed, { rawExitCode: null, signal: null, toolchain: null, executionFiles: [], attributed: false, ...extra });
  parsed.durationMs = Date.now() - started;
  log(
    `  [${label}] ${plan.file} (playwright) -> ${parsed.kind}` +
      ` (pass ${parsed.passed ?? '?'}, fail ${parsed.failed ?? '?'}, total ${parsed.total ?? '?'}, exit ${parsed.rawExitCode ?? '?'}, ${parsed.durationMs}ms)`,
  );
  for (const line of parsed.evidence ?? []) log(`    ${line}`);
  return parsed;
}

/** Build the viewer for this side of the revert, then run the one scoped spec. */
export function runBrowserPlan(plan, root, label, log = console.log) {
  const started = Date.now();
  const env = baseEnv();
  const { build } = plan.runner;
  if (build) {
    const buildCommand = resolveCommand(build.bin, root, root);
    if (!buildCommand) {
      return finish({ kind: 'runner-missing', passed: null, failed: null, total: null, evidence: [`\`${BROWSER_BUILD_SCRIPT}\` needs ${build.bin}, which was not found; run pnpm install`] }, {}, started, plan, label, log);
    }
    log(`  [${label}] building the viewer: ${build.bin} ${build.args.join(' ')}`);
    const built = spawnSync(buildCommand.bin, [...buildCommand.prefix, ...build.args], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: BUILD_TIMEOUT_MS });
    if (built.error || built.signal || built.status !== 0) {
      return finish({
        kind: 'load-failure', passed: null, failed: null, total: null,
        evidence: [`\`${BROWSER_BUILD_SCRIPT}\` failed (${built.error?.message ?? built.signal ?? `exit ${built.status}`}), so no browser assertion ran`],
      }, { tail: tailOf(built) }, started, plan, label, log);
    }
  }
  const command = resolveCommand(plan.runner.bin, root, root);
  if (!command) {
    return finish({ kind: 'runner-missing', passed: null, failed: null, total: null, evidence: ['the playwright binary was not found; run pnpm install'] }, {}, started, plan, label, log);
  }
  const dir = mkdtempSync(join(tmpdir(), 'revert-oracle-playwright-'));
  const reportPath = join(dir, 'report.json');
  let run, report = null, readError = null;
  try {
    run = spawnSync(command.bin, [...command.prefix, ...browserRunArgs(plan.runner, plan.file, { globalTimeoutMs: GLOBAL_TIMEOUT_MS })], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: RUN_TIMEOUT_MS,
      // A private port: the config reuses any server already on its port,
      // which would serve some other build than the one just made.
      env: { ...env, PLAYWRIGHT_PORT: String(freePort()), PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath },
    });
    if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const parsed = parsePlaywrightReport(report, {
    exitCode: run?.status ?? null, signal: run?.signal ?? null, sameFile: sameFileAs(root, plan.file, report),
  });
  if (readError) parsed.evidence.unshift(`could not read the Playwright report: ${readError}`);
  if (run?.error) parsed.evidence.unshift(`playwright did not complete: ${run.error.message}`);
  const version = spawnSync(command.bin, [...command.prefix, '--version'], { encoding: 'utf8', timeout: 30_000 });
  return finish(parsed, {
    rawExitCode: run?.status ?? null,
    signal: run?.signal ?? null,
    toolchain: `${version.stdout ?? ''}`.trim() || 'playwright (version unavailable)',
    executionFiles: [resolve(root, plan.file)],
    attributed: readError === null && report !== null && parsed.foreign === 0 && Number.isInteger(parsed.total) && parsed.total > 0,
    tail: run ? tailOf(run) : readError ?? '',
  }, started, plan, label, log);
}
