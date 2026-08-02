/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { pickPredefinedType } from './entity-predefined-type.js';

describe('pickPredefinedType (#1364)', () => {
  it('returns the PredefinedType enum token from schema-named attributes', () => {
    const attrs = [
      { name: 'Name', value: 'Floor:Generic 150mm' },
      { name: 'ObjectType', value: 'Floor:Generic 150mm' },
      { name: 'PredefinedType', value: 'FLOOR' }, // markers already stripped by the extractor
    ];
    assert.equal(pickPredefinedType(attrs), 'FLOOR');
  });

  it('returns USERDEFINED / NOTDEFINED tokens verbatim (they are valid buckets)', () => {
    assert.equal(pickPredefinedType([{ name: 'PredefinedType', value: 'USERDEFINED' }]), 'USERDEFINED');
    assert.equal(pickPredefinedType([{ name: 'PredefinedType', value: 'NOTDEFINED' }]), 'NOTDEFINED');
  });

  it('returns undefined when the slot is absent', () => {
    assert.equal(pickPredefinedType([{ name: 'Name', value: 'Wall-01' }]), undefined);
  });

  it('returns undefined when the slot is present but empty', () => {
    assert.equal(pickPredefinedType([{ name: 'PredefinedType', value: '' }]), undefined);
    assert.equal(pickPredefinedType([{ name: 'PredefinedType', value: '   ' }]), undefined);
  });
});
