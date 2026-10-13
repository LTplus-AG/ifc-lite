/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7374: positive representability fixtures for this owned child only. These
// valid Linux identity inputs use the real owner SHA256 algorithm. No host
// files, PID, admission checks or generated journal values are changed.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const readFile = fs.readFile;
const readlink = fs.readlink;
fs.readFile = async function readCleanOwnerFixture(path, options) {
  if (path === '/etc/machine-id') return '00000000000000000000000000000001\n';
  if (path === '/proc/sys/kernel/random/boot_id') return '00000000-0000-4000-8000-000000000001\n';
  const value = await readFile.call(this, path, options);
  if (typeof path === 'string' && /^\/proc\/\d+\/stat$/.test(path) && typeof value === 'string') {
    const end = value.lastIndexOf(')') + 2;
    const fields = value.slice(end).trim().split(/\s+/);
    fields[19] = '1';
    return value.slice(0, end) + fields.join(' ');
  }
  return value;
};
fs.readlink = async function readCleanOwnerDomain(path, options) {
  if (path === '/proc/self/ns/pid') return 'pid:[4026531836]';
  return readlink.call(this, path, options);
};
syncBuiltinESMExports();
