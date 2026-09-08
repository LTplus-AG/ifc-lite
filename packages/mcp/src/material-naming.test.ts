/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { MaterialData } from '@ifc-lite/sdk';
import { materialFallbackName } from './material-naming.js';

describe('materialFallbackName', () => {
  it('returns a genuine top-level name unchanged', () => {
    expect(materialFallbackName({ name: 'Concrete' } as MaterialData)).toBe('Concrete');
  });

  // Regression: #3515 chained candidates with `??`, which only falls
  // through on null/undefined. A present-but-blank Name
  // (`IFCMATERIAL('',$,$)`) short-circuited the chain and was returned
  // verbatim instead of falling through to the next candidate.
  it('falls through a blank top-level name to the next candidate', () => {
    const mat = { name: '', materials: [{ name: 'Steel' }] } as MaterialData;
    expect(materialFallbackName(mat)).toBe('Steel');
  });

  // Whitespace-only is a real shape in this codebase (#3714, E57
  // whitespace-only attributes) and is not caught by a bare `''` check.
  it('falls through a whitespace-only top-level name to the next candidate', () => {
    const mat = { name: '   ', materials: [{ name: 'Steel' }] } as MaterialData;
    expect(materialFallbackName(mat)).toBe('Steel');
  });

  it('falls through a blank materials[0].name candidate too', () => {
    const mat = { materials: [{ name: '' }, { name: 'Concrete' }] } as MaterialData;
    // The chain does not look past materials[0]; a blank first entry falls
    // through to the next TIER of candidate (layers/profiles/constituents),
    // not to materials[1] — confirm it falls all the way to undefined when
    // no other tier is present.
    expect(materialFallbackName(mat)).toBeUndefined();
  });

  it('falls through a blank/whitespace layer materialName to a later layer', () => {
    const mat = {
      layers: [{ materialName: '' }, { materialName: '   ' }, { materialName: 'Timber' }],
    } as MaterialData;
    expect(materialFallbackName(mat)).toBe('Timber');
  });

  it('returns undefined, not "", when every candidate is blank', () => {
    const mat = {
      name: '',
      materials: [{ name: '   ' }],
      layers: [{ materialName: '' }],
      profiles: [{ materialName: '  ' }],
      constituents: [{ materialName: '' }],
    } as MaterialData;
    expect(materialFallbackName(mat)).toBeUndefined();
  });

  it('returns undefined for a null/undefined MaterialData (control)', () => {
    expect(materialFallbackName(null)).toBeUndefined();
    expect(materialFallbackName(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty IfcMaterialList (control — already correct on main)', () => {
    expect(materialFallbackName({ materials: [] } as unknown as MaterialData)).toBeUndefined();
  });
});
