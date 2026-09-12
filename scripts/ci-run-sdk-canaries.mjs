/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function runSdkCanaries(root, run) {
  const canaryRoot = join(root, 'tests', 'extensions', 'canaries');
  let entries;
  try {
    entries = readdirSync(canaryRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error(`tests/extensions/canaries is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => join(canaryRoot, entry.name)).sort();
  if (directories.length === 0) throw new Error('tests/extensions/canaries contains no bundle directories');
  const failures = [];
  for (const directory of directories) {
    if (run(directory) !== 0) failures.push(directory);
  }
  if (failures.length > 0) throw new Error(`${failures.length} SDK canary bundle(s) failed: ${failures.join(', ')}`);
  return directories.length;
}

export function main(root = process.cwd()) {
  return runSdkCanaries(resolve(root), (directory) => {
    const result = spawnSync(process.execPath, ['packages/cli/dist/index.js', 'ext', 'test', directory, '--json'], {
      cwd: root,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    console.log(`All ${main()} SDK canary bundle(s) passed.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
