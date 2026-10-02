/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const fs = require('node:fs');
const cp = require('node:child_process');
const root = '/home/louistrue/wt/6566-manual-report-stamp-fix-session6503';
const prefix = '/tmp/6566-session6503/stamp-root-turbo-oracle';
const base = '768c46262180cd06d0d46f8b5ba67f77713f4012';
const production = [
  'apps/viewer/src/components/viewer/document/ManualReportBlockEditor.tsx',
  'apps/viewer/src/components/viewer/document/ManualReportPreview.tsx',
  'apps/viewer/src/components/viewer/document/SavedReportSource.tsx',
  'apps/viewer/src/i18n/catalogues/manual-validation.en.ts',
  'apps/viewer/src/lib/document/compose-manual-report.ts',
  'apps/viewer/src/lib/document/manual-report-types.ts',
  'apps/viewer/src/lib/document/manual-report.ts',
];
const originals = production.map(path => fs.readFileSync(`${root}/${path}`));
const status = () => cp.execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
if (status()) throw Error('The oracle requires a clean owned source before any mutation');
const report = { base, head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), runner: 'Actual root pnpm test with normal Turbo build dependencies, explicit singleton shard environment; no package-local test bypass', production };
function run(label) {
  const runs = [];
  for (const [name, shard] of [['layout', 100883], ['mounted', 295745]]) {
    const result = cp.spawnSync('pnpm', ['test', '--filter=@ifc-lite/viewer', '--env-mode=loose'], { cwd: root, env: { ...process.env, TEST_SHARD: String(shard), TEST_SHARDS: '1000003' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const log = `${prefix}-${label}-${name}.log`;
    fs.writeFileSync(log, output);
    const count = field => Number(output.match(new RegExp(`@ifc-lite/viewer:test: ℹ ${field} (\\d+)`))?.[1] ?? NaN);
    runs.push({ name, shard, log, exitCode: result.status, signal: result.signal, expectedTests: name === 'layout' ? 24 : 8, tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), assertionFailurePresent: output.includes('AssertionError [ERR_ASSERTION]'), loadFailurePresent: /Cannot find module|does not provide an export|SyntaxError:|TypeError:/.test(output) });
  }
  return runs;
}
try {
  report.green = run('green');
  if (report.green.some(run => run.exitCode !== 0 || run.tests !== run.expectedTests || run.pass !== run.tests || run.fail !== 0 || run.skipped !== 0)) throw Error('Candidate failed before source mutation');
  production.forEach(path => fs.writeFileSync(`${root}/${path}`, cp.execFileSync('git', ['show', `${base}:${path}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 })));
  report.reverted = run('reverted');
} finally {
  production.forEach((path, index) => fs.writeFileSync(`${root}/${path}`, originals[index]));
  report.restoredBytes = production.every((path, index) => fs.readFileSync(`${root}/${path}`).equals(originals[index]));
  report.restored = run('restored');
  report.clean = status() === '';
  fs.writeFileSync(`${prefix}.json`, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (!report.restoredBytes || !report.clean || report.restored.some(run => run.exitCode !== 0 || run.tests !== run.expectedTests || run.pass !== run.tests || run.fail !== 0 || run.skipped !== 0)) process.exitCode = 2;
else if (!report.reverted || report.reverted.some(run => run.exitCode !== 1 || run.tests !== run.expectedTests || !Number.isFinite(run.fail) || run.fail <= 0 || run.pass + run.fail !== run.tests || run.skipped !== 0 || !run.assertionFailurePresent || run.loadFailurePresent)) process.exitCode = 3;
