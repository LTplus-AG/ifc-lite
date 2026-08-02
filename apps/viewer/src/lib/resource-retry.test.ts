/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveResourceRetryTier, type ResourceRetryInputs } from './resource-retry.js';

const base: ResourceRetryInputs = {
  kind: 'out_of_memory',
  attemptedTier: undefined, // engine default (medium)
  isPrimary: true,
  alreadyRetried: false,
};

describe('resolveResourceRetryTier', () => {
  it('retries at lowest for each resource-limit kind on a primary WASM load', () => {
    for (const kind of ['out_of_memory', 'geometry_worker_crash', 'geometry_stream_stalled'] as const) {
      assert.equal(resolveResourceRetryTier({ ...base, kind }), 'lowest', kind);
    }
  });

  it('retries from an already-lowered tier that is still above lowest', () => {
    assert.equal(resolveResourceRetryTier({ ...base, attemptedTier: 'low' }), 'lowest');
    assert.equal(resolveResourceRetryTier({ ...base, attemptedTier: 'medium' }), 'lowest');
    assert.equal(resolveResourceRetryTier({ ...base, attemptedTier: 'high' }), 'lowest');
  });

  it('does NOT retry when already at the lowest tier — nowhere lower to go', () => {
    assert.equal(resolveResourceRetryTier({ ...base, attemptedTier: 'lowest' }), null);
  });

  it('does NOT retry a load that never ran the WASM tessellation path', () => {
    // GLB / point-cloud / server / cache loads leave attemptedTier null: a
    // lower IFC tier cannot change their memory, so retrying just repeats work.
    assert.equal(resolveResourceRetryTier({ ...base, attemptedTier: null }), null);
  });

  it('does NOT retry a federated add (must not downgrade the whole federation)', () => {
    assert.equal(resolveResourceRetryTier({ ...base, isPrimary: false }), null);
  });

  it('does NOT retry twice — a failing lowest-tier attempt surfaces', () => {
    assert.equal(resolveResourceRetryTier({ ...base, alreadyRetried: true }), null);
  });

  it('does NOT retry a non-resource failure', () => {
    for (const kind of ['wasm_engine_load', 'file_unreadable', 'cancelled', 'unknown'] as const) {
      assert.equal(resolveResourceRetryTier({ ...base, kind }), null, kind);
    }
  });

  it('the guards compose — every disqualifier wins over a qualifying kind', () => {
    // A resource kind that would retry, but each guard independently blocks it.
    assert.equal(resolveResourceRetryTier({ ...base, kind: 'out_of_memory', isPrimary: false }), null);
    assert.equal(resolveResourceRetryTier({ ...base, kind: 'out_of_memory', alreadyRetried: true }), null);
    assert.equal(resolveResourceRetryTier({ ...base, kind: 'out_of_memory', attemptedTier: null }), null);
    assert.equal(resolveResourceRetryTier({ ...base, kind: 'out_of_memory', attemptedTier: 'lowest' }), null);
  });
});
