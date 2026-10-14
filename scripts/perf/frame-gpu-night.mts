#!/usr/bin/env -S npx tsx
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Explicit scheduled invocation only; task installation is a separate review. */
import { resolve } from 'node:path';
import { runNativeNight } from './frame-gpu-night-controller.js';

const args = process.argv.slice(2);
const names = ['--checkout', '--profile', '--profile-sha', '--out', '--lease', '--night', '--start', '--end'];
const authorizationNames = ['--authorization', '--authorization-sha'];
const unattended = args.includes('--authorization') || args.includes('--authorization-sha');
if (unattended) names.push(...authorizationNames);
if (args.length !== names.length * 2 || names.some(name => args.filter(arg => arg === name).length !== 1)) {
  throw new Error('pass exactly --checkout --profile --profile-sha --out --lease --night --start --end with their explicit values');
}
const value = (name: string): string => {
  const result = args[args.indexOf(name) + 1];
  if (!result || result.startsWith('--')) throw new Error(`missing ${name}`);
  return result;
};
const result = await runNativeNight({ checkout: resolve(value('--checkout')), profileFile: resolve(value('--profile')),
  profileSha256: value('--profile-sha'),
  outputRoot: resolve(value('--out')), leaseFile: resolve(value('--lease')), night: value('--night'),
  startsAt: value('--start'), endsAt: value('--end'),
  ...(unattended ? { authorization: { path: resolve(value('--authorization')), sha256: value('--authorization-sha') } } : {}) });
console.log(JSON.stringify(result));
process.exitCode = result.attempt.status === 'ok' ? 0 : result.attempt.status === 'refused' ? 2 : 1;
