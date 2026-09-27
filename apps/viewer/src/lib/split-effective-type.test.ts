/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView, StoreEditor, type IfcAttributeValue } from '@ifc-lite/mutations';
import { makeStubDataStore } from './__test__/stubs.js';
import { resolveLinearElementChain } from './linear-element-edit.js';
import { resolveSlabEditChain } from './slab-edit.js';

function authoredElement(type: 'IfcBeam' | 'IfcSlab') {
  const store = makeStubDataStore();
  const view = new MutablePropertyView(null, 'split-types');
  const editor = new StoreEditor(store, view);
  const add = (kind: string, attrs: IfcAttributeValue[]) => editor.addEntity(kind, attrs).expressId;
  const ref = (id: number) => `#${id}`;
  const point = add('IfcCartesianPoint', [[1, 2, 0]]);
  const axis = add('IfcAxis2Placement3D', [ref(point), null, null]);
  const placement = add('IfcLocalPlacement', [null, ref(axis)]);
  const profilePoint = add('IfcCartesianPoint', [[2, 1.5]]);
  const profileAxis = add('IfcAxis2Placement2D', [ref(profilePoint), null]);
  const profile = add('IfcRectangleProfileDef', ['.AREA.', null, ref(profileAxis), 4, 3]);
  const solid = add('IfcExtrudedAreaSolid', [ref(profile), null, null, 0.3]);
  const representation = add('IfcShapeRepresentation', [null, 'Body', 'SweptSolid', [ref(solid)]]);
  const shape = add('IfcProductDefinitionShape', [null, null, [ref(representation)]]);
  const element = add(type, ['guid', null, type, null, null, ref(placement), ref(shape), null]);
  return { store, view, editor, element, profile };
}

it('split editors use the live class after an in-store retype (#5249)', () => {
  const beam = authoredElement('IfcBeam');
  assert.ok(resolveLinearElementChain(beam.store, beam.view, beam.editor, beam.element));
  assert.equal(beam.editor.setEntityType(beam.element, 'IfcWall'), true);
  assert.equal(resolveLinearElementChain(beam.store, beam.view, beam.editor, beam.element), null);

  const slab = authoredElement('IfcSlab');
  assert.ok(resolveSlabEditChain(slab.store, slab.view, slab.editor, slab.element));
  assert.equal(slab.editor.setEntityType(slab.element, 'IfcWall'), true);
  assert.equal(resolveSlabEditChain(slab.store, slab.view, slab.editor, slab.element), null);

  const profile = authoredElement('IfcSlab');
  assert.ok(resolveSlabEditChain(profile.store, profile.view, profile.editor, profile.element));
  assert.equal(profile.editor.setEntityType(profile.profile, 'IfcCircleProfileDef'), true);
  assert.equal(resolveSlabEditChain(profile.store, profile.view, profile.editor, profile.element), null);
});
