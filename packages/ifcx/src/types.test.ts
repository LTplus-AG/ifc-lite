/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isTypedPropertyValue } from './types.js';

/**
 * `isTypedPropertyValue` is the strict shape test that disambiguates a
 * genuine typed property record (`{type, value, unit?, source?}`) from
 * any other object. It is shared by three packages: ifcx's own
 * property/quantity extraction, collab's `isPropertyValueShaped` (which
 * decides whether an attribute inflates into the psets CRDT branch or
 * stays flat), and merge's component-state handling of pset properties.
 *
 * The extra-key rejection loop at the end of the function is what makes
 * the test strict rather than permissive: without it, any object that
 * happens to carry `type` (string) and `value` (string | number |
 * boolean | null) would pass — including one with unrelated additional
 * keys — and every one of ifcx/collab/merge's suites stayed green when
 * that loop was deleted, so nothing pinned it.
 */
describe('isTypedPropertyValue — extra-key strict rejection', () => {
  it('accepts the canonical {type, value} shape', () => {
    assert.equal(isTypedPropertyValue({ type: 'IfcText', value: 'hello' }), true);
  });

  it('accepts type/value plus the two documented optional keys', () => {
    assert.equal(
      isTypedPropertyValue({ type: 'IfcReal', value: 1.5, unit: 'm', source: 'import' }),
      true
    );
  });

  it('rejects a record with an extra, undocumented key', () => {
    // Same {type, value} pair as the accepted case above, plus one
    // foreign key. This is exactly the shape the loop exists to catch:
    // a record that looks typed at a glance but isn't the exact wire
    // contract, and must not be treated as one.
    assert.equal(
      isTypedPropertyValue({ type: 'IfcText', value: 'hello', extraKey: 'oops' }),
      false
    );
  });

  it('rejects a record with an extra key even when the base fields are well-formed numerics', () => {
    assert.equal(
      isTypedPropertyValue({ type: 'IfcReal', value: 42, extraKey: 'oops' }),
      false
    );
  });
});
