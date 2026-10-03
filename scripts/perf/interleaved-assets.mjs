/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inventory(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('REFUSE: symlink in frozen viewer');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push({ path: relative(root, path), size: statSync(path).size, sha256: await fileHash(path) });
    }
  }
  await walk(root);
  if (!files.some(file => file.path === 'index.html') || !files.some(file => file.path.endsWith('.wasm'))) {
    throw new Error('REFUSE: production viewer lacks index or runtime WASM');
  }
  return files;
}
