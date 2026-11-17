/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567: one manifest-verified fixture lookup for both showcase recorders.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export const sha256File = path => new Promise((done, fail) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex')));
});

/** The catalogued Gaussian manifest entry for `asset` (no local bytes needed). */
export async function catalogEntry(asset) {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'tests/models/manifest.json'), 'utf8'));
  const entry = manifest.files.find(file => file.path === `gaussian/${asset}`);
  if (!entry?.gaussian) throw new Error(`gaussian/${asset} is not a catalogued Gaussian fixture`);
  return entry;
}

/** The catalogued Gaussian entry for `asset`, after checking the local bytes against it. */
export async function verifiedFixture(asset, assetsDir) {
  const entry = await catalogEntry(asset);
  const localPath = join(assetsDir, asset);
  const sha256 = await sha256File(localPath);
  if (sha256 !== entry.sha256) throw new Error(`${localPath} SHA-256 ${sha256} differs from the manifest`);
  return { entry, localPath };
}
