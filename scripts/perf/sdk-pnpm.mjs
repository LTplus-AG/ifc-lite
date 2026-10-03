/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileHash } from './interleaved-assets.mjs';
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 ** 2 }).trim();

export async function selectPnpm(root, output) {
  if (!process.env.RUNNER_TEMP || !process.env.GITHUB_PATH) throw new Error('hosted own tool selection required');
  const packageManager = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager;
  const version = /^pnpm@(\d+\.\d+\.\d+)(?:\+[^\s]+)?$/.exec(packageManager)?.[1];
  if (!version) throw new Error('exact root pnpm version required');
  const launcher = realpathSync(command('which', ['pnpm']));
  if (command(launcher, ['--version']) !== version) throw new Error('action launcher version differs');
  const candidates = [];
  for (let directory = dirname(launcher), depth = 0; depth < 12; depth++, directory = dirname(directory)) candidates.push(directory);
  // Primary pnpm@10.8.1 tools/path + installPnpmToTools: .tools/name/version,
  // then hoisted node_modules. No recursive lookup or arbitrary launcher parsing.
  if (process.env.PNPM_HOME) candidates.push(join(process.env.PNPM_HOME, '.tools', 'pnpm', version, 'node_modules', 'pnpm'));
  const directory = candidates.find(path => {
    const file = join(path, 'package.json');
    if (!existsSync(file)) return false;
    const metadata = JSON.parse(readFileSync(file, 'utf8'));
    return metadata.name === 'pnpm' && metadata.version === version;
  });
  if (!directory) throw new Error('exact installed pnpm package absent from supported finite candidates');
  const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (typeof metadata.bin?.pnpm !== 'string') throw new Error('installed pnpm CLI metadata absent');
  const packageRoot = realpathSync(directory), executable = realpathSync(resolve(packageRoot, metadata.bin.pnpm));
  if (!executable.startsWith(`${packageRoot}/`) || command(process.execPath, [executable, '--version']) !== version) throw new Error('installed CLI/version mismatch');
  const ownedBin = join(process.env.RUNNER_TEMP, 'sdk-pnpm-bin');
  if (existsSync(ownedBin)) throw new Error('new own pnpm selector required');
  mkdirSync(ownedBin); const link = join(ownedBin, 'pnpm'); symlinkSync(executable, link);
  const receipt = { version, launcher, launcherSha256: await fileHash(launcher), packageRoot,
    packageMetadataSha256: await fileHash(join(packageRoot, 'package.json')), executable,
    executableSha256: await fileHash(executable), link, selectedBeforeInputFreeze: true,
    primaryLayout: 'https://github.com/pnpm/pnpm/blob/v10.8.1/tools/path/src/index.ts' };
  writeFileSync(join(output, 'pnpm-selection.json'), JSON.stringify(receipt, null, 2));
  writeFileSync(process.env.GITHUB_PATH, `${ownedBin}\n`, { flag: 'a' });
}
