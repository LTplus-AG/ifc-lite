/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// One authoritative Python validator; JS constructs actual source-build receipts.
import { spawnSync } from 'node:child_process';
import { writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileHash } from './interleaved-assets.mjs';
import { compilerEnvironment } from './native-hosted-process.mjs';
const modeEnvironment = tools => compilerEnvironment({ ...process.env, OBS: '0', CARGO_BUILD_JOBS: '1', CARGO_TERM_COLOR: 'never' }, tools);
export function pythonTools(root, tools) {
  const result = spawnSync(tools.bash, [join(root, 'scripts/perf/probe.sh'), '--prebuilt-tools', tools.python], {
    cwd: root, env: modeEnvironment(tools), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 ** 2,
  });
  if (result.error || result.status !== 0) throw new Error(`native Python closure refused: ${result.error ?? result.stderr}`);
  const value = JSON.parse(result.stdout);
  if (value.python !== tools.python || value.supportsFd !== true) throw new Error('frozen Linux Python FD support required');
  return value;
}
export async function preparePrebuiltReceipt(root, output, provenance, arm) {
  const build = provenance.builds[arm], directory = provenance.directories[arm];
  const stat = statSync(build.binary, { bigint: true });
  const receipt = { protocol: 'native-fd-prebuilt-v1', arm, revision: provenance.revisions[arm], directory,
    binary: { path: build.binary, bytes: Number(stat.size), dev: String(stat.dev), ino: String(stat.ino),
      mtimeNs: String(stat.mtimeNs), sha256: build.binarySha256 },
    controller: { directory: root, head: provenance.sources.find(row => row.directory === root).head },
    files: provenance.nativeRuntimeFiles, environment: provenance.nativePython.environment,
    fixtures: Object.fromEntries(provenance.fixtures.map(row => [row.file, { bytes: row.bytes, sha256: row.sha256 }])) };
  const path = join(output, `${arm}-prebuilt-receipt.json`);
  writeFileSync(path, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  const sha256 = await fileHash(path);
  const result = spawnSync(provenance.tools.bash, [join(root, 'scripts/perf/probe.sh'), '--prebuilt-validate',
    path, sha256, provenance.tools.python], { cwd: directory, env: modeEnvironment(provenance.tools),
    encoding: 'utf8', timeout: 60000, maxBuffer: 1024 ** 2 });
  writeFileSync(join(output, `${arm}-prebuilt-validation.json`), JSON.stringify({ status: result.status,
    signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }));
  if (result.error || result.status !== 0) throw new Error(`authoritative native receipt refused: ${result.error ?? result.stderr}`);
  provenance.files[path] = sha256;
  return { path, sha256, validation: JSON.parse(result.stdout), executionScope: 'held-FD binding; preexec witness alone does not prove success' };
}
export function prebuiltCommand(root, provenance, arm, fixture, witness) {
  const receipt = provenance.prebuiltReceipts[arm];
  return ['bash', join(root, 'scripts/perf/probe.sh'), '--verified-prebuilt', receipt.path, receipt.sha256,
    witness, provenance.tools.python, fixture, '--iters', '5', '--json', '--fingerprint'];
}
export async function prebuiltWitness(root, provenance, arm, fixture, path, execution) {
  // SAME authoritative validator binds trusted intent to the observed initial
  // owner PID/start/group. Actual canonical output and exit remain mandatory.
  const receipt = provenance.prebuiltReceipts[arm], sha256 = await fileHash(path);
  const expected = { ...execution.initialProcessWitness, ppid: execution.parentPid };
  const result = spawnSync(provenance.tools.bash, [join(root, 'scripts/perf/probe.sh'), '--prebuilt-witness',
    receipt.path, receipt.sha256, path, sha256, JSON.stringify(expected), fixture, provenance.tools.python], {
    cwd: provenance.directories[arm], env: modeEnvironment(provenance.tools), encoding: 'utf8', timeout: 60000, maxBuffer: 1024 ** 2,
  });
  if (result.error || result.status !== 0) throw new Error(`native intent witness refused: ${result.error ?? result.stderr}`);
  return { sha256, validation: JSON.parse(result.stdout), scope: 'initial owned process plus trusted frozen FD intent; not sampled native /proc proof' };
}
