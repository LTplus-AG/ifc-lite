/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { lensMaterialNames } from './lens-material-names.js';

describe('lensMaterialNames (#1366)', () => {
  it('returns each layer material of a multi-layer set, not the layer-set name', () => {
    const info = {
      type: 'MaterialLayerSet' as const,
      name: 'Basic Wall: Ext - Gyp/Ins', // layer-set / Revit type name — must NOT become a bucket
      layers: [
        { materialName: 'Gypsum Board', name: 'Finish' },
        { materialName: 'Insulation', name: 'Thermal' },
      ],
    };
    assert.deepEqual(lensMaterialNames(info), ['Gypsum Board', 'Insulation']);
  });

  it('de-duplicates repeated materials (gyp / ins / gyp -> two distinct)', () => {
    const info = {
      type: 'MaterialLayerSet' as const,
      name: 'Wall Type X',
      layers: [
        { materialName: 'Gypsum Board' },
        { materialName: 'Insulation' },
        { materialName: 'Gypsum Board' },
      ],
    };
    assert.deepEqual(lensMaterialNames(info), ['Gypsum Board', 'Insulation']);
  });

  it('falls back to the top-level name for a single plain material', () => {
    const info = { type: 'Material' as const, name: 'Steel S355' };
    assert.deepEqual(lensMaterialNames(info), ['Steel S355']);
  });

  it('collects constituent and profile materials', () => {
    assert.deepEqual(
      lensMaterialNames({ type: 'MaterialConstituentSet' as const, name: 'set', constituents: [{ materialName: 'Concrete' }, { materialName: 'Rebar' }] }),
      ['Concrete', 'Rebar'],
    );
    assert.deepEqual(
      lensMaterialNames({ type: 'MaterialProfileSet' as const, name: 'set', profiles: [{ materialName: 'Steel' }] }),
      ['Steel'],
    );
  });

  it('returns [] for no material info', () => {
    assert.deepEqual(lensMaterialNames(null), []);
    assert.deepEqual(lensMaterialNames(undefined), []);
  });
});
