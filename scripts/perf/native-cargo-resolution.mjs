/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileHash } from './interleaved-assets.mjs';
import { nativeFileIdentity, sameNativeFile } from './native-file-identity.mjs';

// probe.sh changes to the source root, then sources this file before Cargo.
// Keep that resolution order; do not infer the proxy from the caller's PATH.
const script = `set -euo pipefail
printf '%s\\0' "$(command -v cargo)" "$(command -v rustup)" "$(type -t cargo)" "$(type -t rustup)" "$(pwd -P)"
[ -f "$1" ] && source "$1"
printf '%s\\0' "$(command -v cargo)" "$(command -v rustup)" "$(type -t cargo)" "$(type -t rustup)" "$(pwd -P)"
`;
async function cargoEnvReceipt(path) {
  return { path, present: existsSync(path), sha256: existsSync(path) ? await fileHash(path) : null };
}
export async function verifyCanonicalCargoResolution(receipt) {
  const currentEnv = await cargoEnvReceipt(receipt.cargoEnv.path);
  if (currentEnv.present !== receipt.cargoEnv.present || currentEnv.sha256 !== receipt.cargoEnv.sha256) {
    throw new Error('canonical Cargo environment source changed');
  }
  for (const [path, sha256] of Object.entries(receipt.files)) {
    if (await fileHash(path) !== sha256) throw new Error(`canonical Cargo resolution file changed: ${path}`);
  }
  for (const stage of ['before', 'after']) {
    for (const command of Object.values(receipt[stage]).filter(value => typeof value === 'object')) {
      if (realpathSync(command.commandPath) !== command.realPath) throw new Error('canonical Cargo command symlink target changed');
    }
  }
  if (!sameNativeFile(nativeFileIdentity(receipt.after.cargo.realPath), receipt.after.cargo.fileIdentity)) {
    throw new Error('canonical selected Cargo proxy file identity changed');
  }
}
export async function resolveCanonicalCargoShim({ bash, directory = process.cwd(),
  cargoEnvPath = join(process.env.HOME, '.cargo/env'), environment = process.env }) {
  if (![bash, directory, cargoEnvPath].every(isAbsolute)) throw new Error('absolute canonical Cargo resolution inputs required');
  const receipt = { directory: realpathSync(directory), bash: { path: bash, sha256: await fileHash(bash) },
    cargoEnv: await cargoEnvReceipt(cargoEnvPath), scope: 'Selected commands before/after canonical CargoEnv source; no environment dump' };
  const result = spawnSync(bash, ['-c', script, 'canonical-cargo-resolution', cargoEnvPath],
    { cwd: directory, env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 });
  receipt.exit = result.status;
  if (result.error || result.status !== 0) {
    const error = new Error(`canonical Cargo environment resolution failed: exit=${result.status}; ${result.error?.message ?? 'source/command failure'}`);
    error.resolutionReceipt = receipt; throw error;
  }
  const fields = result.stdout.split('\0');
  if (fields.length !== 11 || fields[10] !== '') throw new Error('canonical Cargo command-only resolution output refused');
  const files = { [bash]: receipt.bash.sha256 };
  for (const [stage, offset] of [['before', 0], ['after', 5]]) {
    const selected = {};
    for (const [name, index] of [['cargo', 0], ['rustup', 1]]) {
      const commandPath = fields[offset + index], kind = fields[offset + index + 2];
      if (kind !== 'file' || !isAbsolute(commandPath) || commandPath.includes('\n')) {
        throw new Error('canonical Cargo requires selected absolute executable files');
      }
      const realPath = realpathSync(commandPath), sha256 = await fileHash(realPath);
      selected[name] = { commandPath, realPath, sha256, fileIdentity: nativeFileIdentity(realPath) };
      files[realPath] = sha256;
    }
    selected.cwd = fields[offset + 4];
    if (selected.cwd !== receipt.directory) throw new Error('canonical Cargo environment changed source cwd');
    receipt[stage] = selected;
  }
  if (receipt.cargoEnv.present) files[cargoEnvPath] = receipt.cargoEnv.sha256;
  receipt.files = files;
  receipt.rawCommandResolution = result.stdout;
  await verifyCanonicalCargoResolution(receipt);
  return receipt;
}
