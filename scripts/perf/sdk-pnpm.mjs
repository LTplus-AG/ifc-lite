/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileHash } from './interleaved-assets.mjs';
const command = (program, args, cwd) => execFileSync(program, args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 ** 2 }).trim();

export async function selectPnpm(root, output) {
  if (!process.env.RUNNER_TEMP || !process.env.GITHUB_PATH) throw new Error('hosted own tool selection required');
  const packageManager = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager;
  const version = /^pnpm@(\d+\.\d+\.\d+)(?:\+[^\s]+)?$/.exec(packageManager)?.[1];
  if (!version) throw new Error('exact root pnpm version required');
  const launcher = realpathSync(command('which', ['pnpm']));
  const launcherVersion = command(launcher, ['--version'], root);
  if (launcherVersion !== version) throw new Error('action launcher version differs');
  const packageDirectory = join(process.env.RUNNER_TEMP, 'sdk-pnpm-package');
  const ownedBin = join(process.env.RUNNER_TEMP, 'sdk-pnpm-bin');
  if (existsSync(packageDirectory) || existsSync(ownedBin)) throw new Error('new own pnpm installation/selector required');
  mkdirSync(packageDirectory);
  const installer = realpathSync(command('which', ['npm']));
  const args = ['install', '--prefix', packageDirectory, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `pnpm@${version}`];
  const receiptPath = join(output, 'pnpm-selection.json');
  const receipt = { status: 'installing', version, launcher, launcherVersion, launcherSha256: await fileHash(launcher),
    installer, installerSha256: await fileHash(installer), installerVersion: command(installer, ['--version'], packageDirectory),
    command: [installer, ...args], startedUTC: new Date().toISOString(), files: {} };
  const save = () => writeFileSync(receiptPath, JSON.stringify(receipt, null, 2)); save();
  try {
    const result = spawnSync(installer, args, { cwd: packageDirectory, timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 ** 2 });
    receipt.exit = result.status; receipt.signal = result.signal;
    for (const [stream, bytes] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
      const path = join(output, `pnpm-install.${stream}.log`);
      writeFileSync(path, bytes ?? Buffer.alloc(0), { flag: 'wx' }); receipt.files[path] = await fileHash(path);
    }
    if (result.error || result.status !== 0 || result.signal) throw result.error ?? new Error('owned pnpm install failed');
    const packageRoot = realpathSync(join(packageDirectory, 'node_modules/pnpm'));
    const metadataPath = join(packageRoot, 'package.json'), metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const lockPath = join(packageDirectory, 'package-lock.json'), lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const locked = lock.packages?.['node_modules/pnpm'];
    if (metadata.name !== 'pnpm' || metadata.version !== version || typeof metadata.bin?.pnpm !== 'string'
      || locked?.version !== version || locked.resolved !== `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(locked.integrity ?? '')) throw new Error('actual installed pnpm metadata/lock/integrity mismatch');
    const executable = realpathSync(resolve(packageRoot, metadata.bin.pnpm));
    if (!executable.startsWith(`${packageRoot}/`) || command(process.execPath, [executable, '--version'], packageDirectory) !== version) throw new Error('installed CLI/version mismatch');
    mkdirSync(ownedBin); const link = join(ownedBin, 'pnpm'); symlinkSync(executable, link);
    Object.assign(receipt, { status: 'selected', packageRoot, packageMetadataSha256: await fileHash(metadataPath), executable,
      executableSha256: await fileHash(executable), integrity: locked.integrity, resolved: locked.resolved, link,
      selectedBeforeInputFreeze: true, scope: 'Fresh exact-version npm installation; original action launcher retained; no action self-update layout assumptions' });
    for (const path of [launcher, installer, metadataPath, lockPath, join(packageDirectory, 'package.json')]) receipt.files[path] = await fileHash(path);
    writeFileSync(process.env.GITHUB_PATH, `${ownedBin}\n`, { flag: 'a' });
  } catch (error) { receipt.status = 'refused'; receipt.reason = String(error); throw error; }
  finally { receipt.endedUTC = new Date().toISOString(); save(); }
}
