/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shared path rules for the modelling-parity reference fixtures (#9296).
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../../..');
// `**/.cache/` is git-ignored repo-wide, so downloads can never be committed.
export const CACHE_DIR = join(HERE, '.cache');
export const MANIFEST_PATH = join(HERE, 'manifest.json');

/** Absolute path of the bytes for one manifest entry (they may not exist yet). */
export function resolveReferencePath(entry) {
  if (entry.fixture) return join(ROOT, 'tests/models', entry.fixture.path);
  return join(CACHE_DIR, entry.id, entry.file);
}
