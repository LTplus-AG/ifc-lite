/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { chmodSync, constants, copyFileSync, lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sha256 } from './exact-route-source.mjs';
export function verifyBinary(path, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected) || !lstatSync(path).isFile() || sha256(readFileSync(path)) !== expected) {
    throw Error('saved executable differs from terminal compiled artifact');
  }
}
export function saveCompiledBinary(compiled, saved, expected) {
  copyFileSync(compiled, saved, constants.COPYFILE_EXCL);
  chmodSync(saved, 0o500);
  verifyBinary(saved, expected); // A shared-target replacement during copying refuses.
  return { path: compiled, artifact: 'capture-binary', executedPath: resolve(saved), sha256: expected };
}
export function executeSavedBinary(binary, args, cwd) {
  verifyBinary(binary.executedPath, binary.sha256);
  const execution = spawnSync(binary.executedPath, args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  verifyBinary(binary.executedPath, binary.sha256);
  return { execution, provenance: { executable: binary.executedPath,
    beforeSha256: binary.sha256, afterSha256: binary.sha256 } };
}
export function verifyExecutedBinary(receipt, output, example, files) {
  const saved = resolve(output, 'capture-binary'), expected = files[example.executable];
  if (receipt.binary.path !== example.executable || receipt.binary.artifact !== 'capture-binary' ||
      receipt.binary.executedPath !== saved || receipt.binary.sha256 !== expected) throw Error('saved binary is not terminal compiled executable');
  verifyBinary(saved, expected);
  for (const [i, fixture] of receipt.fixtures.entries()) {
    const p = fixture.execution;
    if (!p || p.executable !== saved || p.beforeSha256 !== expected || p.afterSha256 !== expected ||
        !receipt.commands?.some(c => Array.isArray(c) && c.length === 3 && c[0] === saved &&
          c[2] === resolve(output, `${i}.json`))) throw Error('capture did not execute the verified saved binary');
  }
}
