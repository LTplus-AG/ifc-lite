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

  // Opposite direction: reordering the chain so the member arrays are
  // consulted before the set-level name must not lose a set-level name that
  // used to print. `IfcMaterialProfile.Material` is OPTIONAL in IFC4 (and a
  // constituent's can fail to resolve), so a NAMED set whose members name
  // nothing is ordinary valid IFC — "Materials: ?" names nothing, the set
  // name does.
  it('prefers the set-level name when no profile member is named', () => {
    const mat = { type: 'MaterialProfileSet', name: 'Steel Columns', profiles: [{}] } as MaterialData;
    expect(formatMaterialsBlock(mat)).toBe('  Material: Steel Columns');
  });

  it('prefers the set-level name when no constituent member is named', () => {
    const mat = {
      type: 'MaterialConstituentSet',
      name: 'Facade Buildup',
      constituents: [{}, {}],
    } as MaterialData;
    expect(formatMaterialsBlock(mat)).toBe('  Material: Facade Buildup');
  });

  it('prefers the set-level name when no layer member is named', () => {
    const mat = { type: 'MaterialLayerSet', name: 'Wall Buildup', layers: [{}] } as MaterialData;
    expect(formatMaterialsBlock(mat)).toBe('  Material: Wall Buildup');
  });

  it('still lists members, placeholders and all, when at least one is named', () => {
    const mat = {
      type: 'MaterialLayerSet',
      name: 'Wall Buildup',
      layers: [{ materialName: 'Brick' }, {}],
    } as MaterialData;
    expect(formatMaterialsBlock(mat)).toBe('  Materials: Brick, ?');
  });

  it('returns undefined for an unnamed set whose members are unnamed too', () => {
    expect(formatMaterialsBlock({ type: 'MaterialProfileSet', profiles: [{}] } as MaterialData)).toBeUndefined();
  });

  it('returns undefined when there is nothing to show', () => {
    expect(formatMaterialsBlock(undefined)).toBeUndefined();
    expect(formatMaterialsBlock({} as MaterialData)).toBeUndefined();
  });
});
