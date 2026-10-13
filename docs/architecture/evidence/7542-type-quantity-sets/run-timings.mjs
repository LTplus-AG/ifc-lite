/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// node docs/architecture/evidence/7542-type-quantity-sets/run-timings.mjs <ids dist> [<ids dist> ...]
// #7542: runs every timing in this folder, from the repository root, and writes
// setless-sweep.txt, parsed-model-cost-validate.txt and parsed-model-cost-sweep.txt here.
//
// The CPU load of all cores is sampled five times, 200 ms apart: Win32_Processor.LoadPercentage
// through PowerShell on Windows, elsewhere os.loadavg()[0] over the core count. Before each run
// it waits, up to 5 minutes, for a sample set whose highest value is at most LOAD_MAX percent.
// The samples before and after each run are written beside its output. A run with a sample over
// LOAD_MAX is marked "busy, not used" and run again, at most 3 attempts in all. Only runs
// marked "used" go into the README's tables. Each script's stderr (the parser's notes) is
// dropped, as `2>/dev/null` would. With --plan first, it prints the commands and one load
// sample set, and runs nothing.
import { spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';

const LOAD_MAX = 10;
const ATTEMPTS = 3;
const WAIT_MS = 5 * 60 * 1000;
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const here = relative(root, fileURLToPath(new URL('.', import.meta.url))).replaceAll('\\', '/');
const plan = process.argv[2] === '--plan';
const builds = process.argv.slice(plan ? 3 : 2);
if (builds.length === 0) throw new Error('usage: run-timings.mjs [--plan] <ids dist> [<ids dist> ...]');

function loadSamples() {
  if (process.platform === 'win32') {
    const ps = '$s = 1..5 | ForEach-Object { (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; Start-Sleep -Milliseconds 200 }; ($s -join ",")';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    return r.stdout.trim().split(',').map((v) => Math.round(Number(v)));
  }
  const out = [];
  for (let i = 0; i < 5; i++) {
    out.push(Math.round((100 * loadavg()[0]) / cpus().length));
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
  }
  return out;
}
const busy = (samples) => samples.some((v) => !(v <= LOAD_MAX));
function waitForIdle() {
  const until = Date.now() + WAIT_MS;
  let samples = loadSamples();
  while (busy(samples) && Date.now() < until) {
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    samples = loadSamples();
  }
  return samples;
}

function run(file, label, args) {
  if (plan) {
    console.log(`${relative(root, file)}, ${label}: node ${args.join(' ')}`);
    return;
  }
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const before = waitForIdle();
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
    const after = loadSamples();
    const used = !busy(before) && !busy(after);
    appendFileSync(file, [
      `# ${label}, attempt ${attempt}`,
      `$ node ${args.join(' ')} 2>/dev/null`,
      `CPU load % before: ${before.join(', ')}`,
      r.stdout.trimEnd(),
      `exit ${r.status}`,
      `CPU load % after: ${after.join(', ')}`,
      used ? 'load: used' : `load: busy (a sample over ${LOAD_MAX}%), not used`,
      '',
    ].join('\n'));
    console.log(`${label} attempt ${attempt}: ${used ? 'used' : 'busy'}`);
    if (used) return;
  }
}

const sweepOut = `${root}${here}/setless-sweep.txt`;
const validateOut = `${root}${here}/parsed-model-cost-validate.txt`;
const costSweepOut = `${root}${here}/parsed-model-cost-sweep.txt`;
if (plan) console.log(`CPU load % now: ${loadSamples().join(', ')}`);
else for (const f of [sweepOut, validateOut, costSweepOut]) writeFileSync(f, '');

for (let n = 1; n <= 3; n++) run(sweepOut, `run ${n}`, [`${here}/setless-sweep.mjs`, '50000', '11', ...builds]);
const cost = (scenario, mode) => ['--expose-gc', `${here}/parsed-model-cost.mjs`, scenario, mode, '11', ...builds];
for (let n = 1; n <= 3; n++) run(validateOut, `primary, run ${n}`, cost('primary', 'validate'));
for (const scenario of ['no-type-qto', 'own-full-set']) {
  for (let n = 1; n <= 2; n++) run(validateOut, `${scenario}, run ${n}`, cost(scenario, 'validate'));
}
for (const scenario of ['primary', 'no-type-qto', 'own-full-set']) {
  for (let n = 1; n <= 2; n++) run(costSweepOut, `${scenario}, run ${n}`, cost(scenario, 'sweep'));
}
