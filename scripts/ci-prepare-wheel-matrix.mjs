/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const EXPECTED_WHEEL_ARTIFACTS = [
  'wheels-ubuntu-latest-x86_64',
  'wheels-ubuntu-latest-aarch64',
  'wheels-macos-14-aarch64',
  'wheels-macos-14-x86_64',
  'wheels-windows-latest-x64',
];

export function prepareWheelMatrix(root) {
  const dist = join(root, 'dist');
  const artifactDirectories = readdirSync(dist, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('wheels-'))
    .map((entry) => entry.name)
    .sort();
  const expected = [...EXPECTED_WHEEL_ARTIFACTS].sort();
  if (JSON.stringify(artifactDirectories) !== JSON.stringify(expected)) {
    throw new Error(`wheel artifact directories differ: expected ${expected.join(', ')}, got ${artifactDirectories.join(', ')}`);
  }
  const publish = join(dist, 'publish');
  mkdirSync(publish, { recursive: true });
  for (const artifact of EXPECTED_WHEEL_ARTIFACTS) {
    const directory = join(dist, artifact);
    const wheels = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.whl'));
    if (wheels.length !== 1) throw new Error(`${artifact} must contain exactly one wheel; found ${wheels.length}`);
    copyFileSync(join(directory, wheels[0].name), join(publish, wheels[0].name));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    prepareWheelMatrix(process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
