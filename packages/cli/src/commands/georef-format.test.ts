/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { GeoreferencingState } from '@ifc-lite/sdk';
import { verifyWritten } from './georef-format.js';

const state = (unit: Record<string, unknown>) => ({
  hasGeoreference: true,
  ProjectedCRS: { type: 'IfcProjectedCRS', Name: 'EPSG:2229', ...unit },
  MapConversion: null,
}) as unknown as GeoreferencingState;

describe('verifyWritten compares the unit, not only its name', () => {
  it('a unit that reads back with the right name but an unresolved factor is a mismatch', () => {
    const out = verifyWritten(state({ MapUnit: 'FOOT' }), state({ MapUnit: 'FOOT', mapUnitResolved: false }), {} as never);
    expect(out.join('\n')).toMatch(/MapUnit.*unresolved/);
  });
  it('a resolved unit passes', () => {
    expect(verifyWritten(state({ MapUnit: 'FOOT' }), state({ MapUnit: 'FOOT', mapUnitResolved: true }), {} as never).filter((m) => /MapUnit/.test(m))).toEqual([]);
  });

  it('a removal that leaves nothing to read is a success, not "could not be read back"', () => {
    const empty = { hasGeoreference: false, ProjectedCRS: null, MapConversion: null, RigidOperation: null } as unknown as GeoreferencingState;
    expect(verifyWritten(empty, empty, null)).toEqual([]);
  });
});
