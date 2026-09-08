/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateProvenance } from './provenance.js';

/**
 * Per docs/architecture/layer-prs/03-provenance.md §3.1, `merge` is a
 * required manifest field (present as `"merge": null` in the schema
 * example even for non-merge layers, matching the ProvenanceManifest
 * type's `merge: MergeRecord | null`, not `merge?:`). An untrusted
 * manifest that omits the key entirely is malformed, the same way one
 * that omits `base` is caught below.
 */
function validManifestMissingMerge(): Record<string, unknown> {
  const m: Record<string, unknown> = {
    v: 1,
    author: { kind: 'human', principal: 'x' },
    intent: 'test',
    created: new Date().toISOString(),
    base: null,
    parents: [],
    scope_claim: [],
    identity_map: [],
    checks: [],
    signatures: [],
  };
  // `merge` intentionally absent -- not even `merge: undefined`, the key
  // itself is missing, as a JSON.parse of a hand-written manifest would do.
  return m;
}

describe('validateProvenance', () => {
  it('rejects a manifest that omits the required `merge` key entirely', () => {
    const errors = validateProvenance(validManifestMissingMerge());
    assert.ok(
      errors.some((e) => e.includes('merge')),
      `expected a merge-related error, got: ${JSON.stringify(errors)}`
    );
  });

  it('still accepts a literal `merge: null` (non-merge layer)', () => {
    const manifest = { ...validManifestMissingMerge(), merge: null };
    assert.deepStrictEqual(validateProvenance(manifest), []);
  });

  it('still rejects a malformed non-null merge object', () => {
    const manifest = { ...validManifestMissingMerge(), merge: { candidate: 'x' } };
    assert.ok(validateProvenance(manifest).length > 0);
  });
});
