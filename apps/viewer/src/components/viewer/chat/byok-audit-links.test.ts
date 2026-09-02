/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BYOK modal's whole purpose is claims a user can check, and its strongest
 * one is a link to the code that handles their key. Those paths are hand-typed
 * strings behind a github.com/blob/main URL: rename a file and the claim
 * becomes a 404 while every other test stays green — the failure is invisible
 * from inside the app, which is exactly where a trust claim must not fail.
 *
 * This asserts each path resolves on disk. It cannot prove the file still does
 * what the bullet says, but it does catch the rename.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_SRC = path.resolve(here, '../../..');

/**
 * Read the paths out of the source rather than importing the module: the
 * modal pulls in the whole Radix/lucide tree, and this check needs neither.
 */
function pathsDeclaredIn(file: string): string[] {
  const source = readFileSync(path.join(VIEWER_SRC, file), 'utf8');
  return [...source.matchAll(/'((?:lib|components|services)\/[\w./-]+\.tsx?)'/g)].map((m) => m[1]);
}

describe('BYOK audit links', () => {
  it('every source path the modal links to exists', () => {
    const declared = [
      ...pathsDeclaredIn('components/viewer/chat/ByokKeyModal.tsx'),
      ...pathsDeclaredIn('components/mcp/PlaygroundChat.tsx'),
    ];
    assert.ok(declared.length >= 3, `expected the audit paths to be found, got ${declared.length}`);
    for (const rel of declared) {
      assert.ok(
        existsSync(path.join(VIEWER_SRC, rel)),
        `${rel} is linked as BYOK audit source but does not exist under apps/viewer/src`,
      );
    }
  });
});
