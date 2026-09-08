/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { materialDisplayName } from './material-name.js';
import type { MaterialInfo } from '@ifc-lite/parser';

test('materialDisplayName reads a plain material name', () => {
  assert.equal(materialDisplayName({ type: 'Material', name: 'Timber' } as MaterialInfo), 'Timber');
});

test('materialDisplayName falls back to the first IfcMaterialList member', () => {
  const mat = { type: 'MaterialList', materials: [{ name: 'Concrete' }, { name: 'Rebar' }] } as MaterialInfo;
  assert.equal(materialDisplayName(mat), 'Concrete');
});

// Regression: an unnamed IfcMaterialLayerSet/ProfileSet/ConstituentSet used
// to be read via `rawMaterial?.name ?? rawMaterial?.materials?.[0]?.name`
// alone in context-builder.ts, which has no leg for `.layers[]`,
// `.profiles[]` or `.constituents[]` — so the LLM context silently
// reported no material at all for any element whose material association
// resolves to one of those set types without a set-level Name.
test('materialDisplayName falls back to an unnamed MaterialLayerSet member, not silently', () => {
  const mat = { type: 'MaterialLayerSet', layers: [{ materialName: 'Steel' }] } as MaterialInfo;
  assert.equal(materialDisplayName(mat), 'Steel');
});

test('materialDisplayName falls back to an unnamed MaterialProfileSet member, not silently', () => {
  const mat = { type: 'MaterialProfileSet', profiles: [{ materialName: 'Aluminium' }] } as MaterialInfo;
  assert.equal(materialDisplayName(mat), 'Aluminium');
});

test('materialDisplayName falls back to an unnamed MaterialConstituentSet member, not silently', () => {
  const mat = { type: 'MaterialConstituentSet', constituents: [{ materialName: 'Insulation' }] } as MaterialInfo;
  assert.equal(materialDisplayName(mat), 'Insulation');
});

test('materialDisplayName returns undefined when nothing is available', () => {
  assert.equal(materialDisplayName(undefined), undefined);
  assert.equal(materialDisplayName({ type: 'Material' } as MaterialInfo), undefined);
});
