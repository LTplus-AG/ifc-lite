/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** @changesets/read's `ignoredMdFiles`, verbatim. */
const IGNORED_MD = [/^README\.md$/i, 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

/**
 * The pending changeset file names in `<repoRoot>/.changeset`, sorted. An
 * absent `.changeset` directory is zero pending; any other read error throws.
 */
export function pendingChangesets(repoRoot) {
  let entries;
  try {
    entries = readdirSync(join(repoRoot, '.changeset'), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter(
      (name) =>
        !name.startsWith('.') &&
        name.endsWith('.md') &&
        !IGNORED_MD.some((p) => (typeof p === 'string' ? p === name : p.test(name)))
    )
    .sort();
}

