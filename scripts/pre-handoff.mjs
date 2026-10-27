/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRuns } from './lib/revert-oracle-plan-runs.mjs';
import { resolveCommand } from './lib/revert-oracle-run-plan.mjs';
import { classifyDiff, parseNameStatus } from './lib/revert-oracle.mjs';
import { discoverOracles, oracleArgs } from './revert-oracle-discover.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

export function gateCommands(base) {
  return [
    { name: 'source-text-assertions', args: ['scripts/check-source-text-assertions.mjs', '--base', base], deps: ['typescript'] },
    { name: 'test-wiring', args: ['scripts/check-test-wiring.mjs'] },
    { name: 'module-size', args: ['scripts/check-module-size.mjs', '--base', base] },
    { name: 'ci-path-coverage', args: ['scripts/check-ci-path-coverage.mjs'] },
    { name: 'ci-aggregate-coverage', args: ['scripts/check-ci-aggregate-coverage.mjs'] },
    { name: 'workflow-report-paths', args: ['scripts/check-workflow-report-paths.mjs'], deps: ['yaml'] },
    { name: 'agents-md-size', args: ['scripts/check-agents-md-size.mjs'] },
    { name: 'license-headers', args: ['scripts/add-license-headers.mjs', '--check'] },
    { name: 'pr-review-signal lanes', args: ['--test', '--test-name-pattern=the REAL test.yml derives', 'scripts/lib/pr-review-signal.test.mjs'] },
    { name: 'retained-free viewer', args: ['scripts/check-viewer-retained-free.mjs'], needs: 'apps/viewer/dist' },
  ];
}

export function missingDependencies(root, dependencies = []) {
  const require = createRequire(resolve(root, 'package.json'));
  return dependencies.filter((dependency) => {
    try { require.resolve(dependency); return false; }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return true; }
  });
}

/** Keep failures distinct from unavailable prerequisites; always finish the table. */
export function runGates(root, commands, log = console.log) {
  return commands.map(({ name, args, deps, needs, unavailable }) => {
    const missing = missingDependencies(root, deps);
    const reason = unavailable || (missing.length ? `missing ${missing.join(', ')}; run pnpm install`
      : needs && !existsSync(resolve(root, needs)) ? `${needs} absent; build the default viewer first` : null);
    if (reason) {
      log(`SKIPPED ${name}: ${reason}`);
      return { gate: name, result: 'SKIPPED', detail: reason };
    }
    log(`\nRUN node ${args.join(' ')}`);
    const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (run.stdout) log(run.stdout.trimEnd());
    if (run.stderr) log(run.stderr.trimEnd());
    const result = run.status === 0 && !run.error && !run.signal ? 'PASS' : 'FAIL';
    return { gate: name, result, detail: run.error?.message ?? `exit ${run.status}${run.signal ? ` (${run.signal})` : ''}` };
  });
}

/** Preflight derived runners so a missing local toolchain is explicitly skipped. */
export function oraclePrerequisites(root, oracle, base) {
  const tests = oracle.test ? [oracle.test] : classifyDiff(parseNameStatus(execFileSync('git',
    ['diff', '--name-status', `${base}...HEAD`], { cwd: root, encoding: 'utf8' }))).test
    .map((entry) => entry.path).filter((path) => existsSync(resolve(root, path)));
  const missing = new Set();
  for (const { runner, dir } of planRuns(tests, root).plans) {
    if (!runner) continue; // An unsupported adapter is a failure, not a dependency skip.
    const command = resolveCommand(runner.bin, dir, root);
    if (!command) missing.add(`${runner.bin} (run pnpm install)`);
    else if (['cargo', 'python3'].includes(runner.bin)) {
      const probe = spawnSync(command.bin, [...command.prefix, '--version'], { cwd: root, encoding: 'utf8', timeout: 10000 });
      if (probe.error?.code === 'ENOENT' || probe.status !== 0) missing.add(`${runner.bin} toolchain`);
    }
    for (const dependency of runner.args.filter((arg) => ['tsx', 'tsx/esm'].includes(arg))) {
      if (missingDependencies(dir, [dependency]).length) missing.add(`${dependency} (run pnpm install)`);
    }
  }
  return missing.size ? `unavailable prerequisites: ${[...missing].join(', ')}` : null;
}

export function main(argv = process.argv.slice(2), root = fileURLToPath(new URL('..', import.meta.url))) {
  let base = 'origin/main';
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== '--base' || !argv[1]) throw new Error('Usage: node scripts/pre-handoff.mjs [--base origin/main]');
    base = argv[1];
  }
  // A dirty/untracked manifest would otherwise silently escape HEAD discovery.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  if (status) throw new Error('Commit local changes before pre-handoff; mutation checks require a clean tree.');
  const diff = execFileSync('git', ['diff', '--name-only', '-z', `${base}...HEAD`], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  console.log(`Pre-handoff: ${diff.length} changed paths vs ${base}; global CI invariants scan their full input scope.`);
  let oracles = [], discoveryError;
  try { oracles = discoverOracles(root, base); }
  catch (error) { discoveryError = error.message; }
  const results = runGates(root, gateCommands(base));
  results.push({ gate: 'oracle discovery', result: discoveryError ? 'FAIL' : 'PASS', detail: discoveryError ?? `${oracles.length} added manifests` });
  for (const oracle of oracles) {
    // The existing oracle derives each language's runner and validates actual
    // assertion evidence. Missing tooling remains a visible failure to explain,
    // unless the entire dependency installation is unavailable up front.
    let unavailable;
    try { unavailable = oraclePrerequisites(root, oracle, base); }
    catch (error) { results.push({ gate: oracle.manifest, result: 'FAIL', detail: error.message }); continue; }
    const deps = oracle.test && /\.[cm]?tsx?$/.test(oracle.test) ? ['typescript'] : [];
    results.push(...runGates(root, [{ name: oracle.manifest, deps, unavailable, args: [
      'scripts/check-test-revert-oracle.mjs', '--base', base, '--ci', '--json',
      '--verify-restored', '--timeout-ms', '120000', ...oracleArgs([oracle]),
    ] }]));
  }
  console.table(results);
  return results.some((row) => row.result === 'FAIL') ? 1 : 0;
}

if (isMainEntry(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.table([{ gate: 'pre-handoff', result: 'FAIL', detail: error.message }]); process.exitCode = 1; }
}
