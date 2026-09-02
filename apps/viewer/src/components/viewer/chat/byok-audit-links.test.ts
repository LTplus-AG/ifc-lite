/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BYOK modal's whole purpose is claims a user can check, and its strongest
 * one is a link to the code that handles their key. Rename a file and the claim
 * becomes a 404 while every other test stays green — a failure invisible from
 * inside the app, which is exactly where a trust claim must not fail.
 *
 * The paths come from the module the modal renders from, not from scanning its
 * source text: a regex over source decides for itself what counts as a path, so
 * rewriting one as a template literal would drop it from the check without
 * failing anything. Importing the values means the test and the modal cannot
 * disagree about what is being claimed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CLIENT_FILES,
  DEFAULT_REQUEST_SOURCE,
  PLAYGROUND_REQUEST_SOURCE,
  allAuditSources,
} from './byok-audit-sources.js';

const VIEWER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('BYOK audit links', () => {
  it('every source path the modal links to exists', () => {
    const sources = allAuditSources();
    assert.ok(sources.length >= 3, `expected at least 3 audit paths, got ${sources.length}`);
    for (const rel of sources) {
      assert.ok(
        existsSync(path.join(VIEWER_SRC, rel)),
        `${rel} is linked as BYOK audit source but does not exist under apps/viewer/src`,
      );
    }
  });

  it('covers both providers and both surfaces', () => {
    // A path list that quietly lost an entry would still pass the check above.
    assert.deepEqual(Object.keys(CLIENT_FILES).sort(), ['anthropic', 'openai']);
    assert.ok(CLIENT_FILES.anthropic.length > 0, 'the Anthropic client file must be linked');
    assert.ok(DEFAULT_REQUEST_SOURCE.length > 0, 'the default request source must be set');
    assert.ok(
      PLAYGROUND_REQUEST_SOURCE.anthropic,
      'the playground drives its own loop, so it must override the request source',
    );
  });
});
