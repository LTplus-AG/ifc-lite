/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { MaterialData } from '@ifc-lite/sdk';
import { formatMaterialsBlock } from './material-summary.js';

describe('formatMaterialsBlock', () => {
  it('formats a plain named material', () => {
    expect(formatMaterialsBlock({ name: 'Timber' } as MaterialData)).toBe('  Material: Timber');
  });

  it('formats an IfcMaterialList by its member names', () => {
    const mat = { materials: [{ name: 'Concrete' }, { name: 'Rebar' }] } as MaterialData;
    expect(formatMaterialsBlock(mat)).toBe('  Materials: Concrete, Rebar');
  });

  // Regression: an IfcMaterialProfileSet or IfcMaterialConstituentSet with
  // no set-level Name used to fall straight through viewer_get_selection's
  // formatting chain (which only checked `.layers`/`.materials` before the
  // final `mat.name ?? mat.materialName` check) to nothing at all — the
  // whole "Materials:" line silently disappeared instead of naming the
  // member material, unlike the `IfcMaterialList` case above.
  it('formats an unnamed MaterialProfileSet by its member profile names, not silently', () => {
    const mat = { profiles: [{ materialName: 'Steel' }] } as MaterialData;
    expect(formatMaterialsBlock(mat)).toBe('  Materials: Steel');
  });

  it('formats an unnamed MaterialConstituentSet by its member constituent names, not silently', () => {
    const mat = { constituents: [{ materialName: 'Insulation' }, { materialName: 'Gypsum' }] } as MaterialData;
    expect(formatMaterialsBlock(mat)).toBe('  Materials: Insulation, Gypsum');
  });

  it('returns undefined when there is nothing to show', () => {
    expect(formatMaterialsBlock(undefined)).toBeUndefined();
    expect(formatMaterialsBlock({} as MaterialData)).toBeUndefined();
  });
});
