/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildAutoColorLensToSave } from './lens-editor-utils.js';

describe('buildAutoColorLensToSave (#1365)', () => {
  it('preserves the existing id when editing a saved lens (so rename updates in place)', () => {
    let generated = false;
    const lens = buildAutoColorLensToSave(
      { id: 'lens-auto-123' },
      { name: 'Renamed lens', autoColor: { source: 'ifcType' } },
      () => { generated = true; return 'lens-auto-SHOULD-NOT-BE-USED'; },
    );

    assert.equal(lens.id, 'lens-auto-123', 'editing must keep the original id');
    assert.equal(generated, false, 'must not generate a new id when editing');
    assert.equal(lens.name, 'Renamed lens');
    assert.deepEqual(lens.autoColor, { source: 'ifcType' });
    assert.deepEqual(lens.rules, []);
  });

  it('mints a fresh id only when creating a new lens (no initial id)', () => {
    const lens = buildAutoColorLensToSave(
      {},
      { name: 'Color by IFC Class', autoColor: { source: 'property', psetName: 'Pset_X', propertyName: 'P' } },
      () => 'lens-auto-FRESH',
    );

    assert.equal(lens.id, 'lens-auto-FRESH');
    assert.equal(lens.name, 'Color by IFC Class');
    assert.deepEqual(lens.autoColor, { source: 'property', psetName: 'Pset_X', propertyName: 'P' });
  });
});
