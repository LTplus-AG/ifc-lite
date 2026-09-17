/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLoadError } from './load-errors.js';
import { formatLoadError } from './load-error-message.js';
import { resolveResourceRetryTier } from './resource-retry.js';

describe('worker script that failed to load (#4886)', () => {
  // The exact messages geometry-parallel.ts synthesizes for an empty-message
  // onerror from a worker that never posted. In production (PostHog, Sep 15/16)
  // both followed tabs left open past Vercel Skew Protection's one-day max age.
  const stale = [
    'Geometry worker failed: worker script failed to load (possibly a stale deployment)',
    'Pre-pass worker failed: worker script failed to load (possibly a stale deployment)',
  ];

  it('is a missing engine file, not a geometry worker crash', () => {
    for (const message of stale) {
      assert.equal(classifyLoadError(new Error(message)), 'wasm_engine_load', message);
    }
  });

  it('tells the user to reload instead of blaming the model size', () => {
    const text = formatLoadError(new Error(stale[0]), 'tower.ifc');
    assert.match(text, /reload the page/i);
    assert.doesNotMatch(text, /memory|too large|closing other tabs/i);
  });

  it('does not start a lowest-tier retry that can only fail the same way', () => {
    const kind = classifyLoadError(new Error(stale[0]));
    assert.equal(
      resolveResourceRetryTier({ kind, attemptedTier: undefined, isPrimary: true, alreadyRetried: false }),
      null,
    );
  });

  it('still treats a worker that crashed after it ran as a worker crash', () => {
    assert.equal(
      classifyLoadError(new Error('Geometry worker failed: worker terminated unexpectedly')),
      'geometry_worker_crash',
    );
  });
});
