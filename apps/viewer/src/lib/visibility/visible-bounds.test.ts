/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5884: Fit All frames what is visible. Two boxes 1 km apart; hiding,
 * isolating or hiding the model of one of them must shrink the framed box to
 * the other. With nothing filtered it stays the outlier-trimmed whole-scene
 * box (#1394).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureModel } from '@/test/store-fixture.js';
import type { FederatedModel } from '@/store';
import type { BoundingBox3D } from '@/utils/viewportUtils';
import { modelHiddenEntities } from './model-hidden-entities.js';
import { fitAllBounds, instancedPassDrawn, type FitAllInput } from './visible-bounds.js';

const box = (x: number, y = 0): BoundingBox3D => ({ min: { x, y, z: 0 }, max: { x: x + 1, y: y + 1, z: 1 } });
const span = (x0: number, x1: number, y1 = 1): BoundingBox3D => ({ min: { x: x0, y: 0, z: 0 }, max: { x: x1, y: y1, z: 1 } });

// A building of 300 elements on a 30 x 10 grid (x 0..30, y 0..10, ids 1..300),
// a far wing of 300 more 1 km east (ids 1001..1300, instanced), and one stray
// element 50 km out (id 9999).
const BOXES = new Map<number, BoundingBox3D>();
for (let i = 0; i < 300; i++) BOXES.set(1 + i, box(i % 30, Math.floor(i / 30)));
for (let i = 0; i < 300; i++) BOXES.set(1001 + i, box(1000 + (i % 30), Math.floor(i / 30)));
BOXES.set(9999, box(50_000));
const BUILDING = [...Array(300)].map((_, i) => 1 + i);
const WING = [...Array(300)].map((_, i) => 1001 + i);
const BUILDING_BOX = span(0, 30, 10);
const WHOLE: BoundingBox3D = { min: { x: -7, y: -7, z: -7 }, max: { x: 7, y: 7, z: 7 } };
const NONE = new Set<number>();
const meshes = (...ids: number[]) => ids.map((expressId) => ({ expressId }));

function fit(over: Partial<FitAllInput>): BoundingBox3D {
  return fitAllBounds({
    meshes: meshes(...BUILDING, 9999),
    instancedIds: WING,
    instancedDrawn: true,
    typeOf: () => undefined,
    boundsOf: (id) => BOXES.get(id) ?? null,
    visibility: { hidden: NONE, isolated: null },
    wholeScene: WHOLE,
    ...over,
  });
}

describe('fitAllBounds (#5884)', () => {
  it('nothing filtered: building and wing, the stray element trimmed away (#1394)', () => {
    assert.deepEqual(fit({}), span(0, 1030, 10));
  });

  it('hidden elements are left out, flat and instanced, and the tail stays trimmed', () => {
    assert.deepEqual(fit({ visibility: { hidden: new Set(WING), isolated: null } }), BUILDING_BOX);
    assert.deepEqual(
      fit({ visibility: { hidden: new Set([BUILDING[0]]), isolated: null } }),
      span(0, 1030, 10),
      'hiding one element does not bring the stray tail back',
    );
  });

  it('frames only the isolation (storey / class filter / isolate)', () => {
    assert.deepEqual(fit({ visibility: { hidden: NONE, isolated: new Set(WING) } }), span(1000, 1030, 10));
  });

  it('isolating the stray element itself frames it', () => {
    assert.deepEqual(fit({ visibility: { hidden: NONE, isolated: new Set([9999]) } }), box(50_000));
  });

  it('with N=2 models, a hidden far-away model B is not framed, its instanced occurrences too', () => {
    const a = fixtureModel('a', { idOffset: 0 });
    const b = { ...fixtureModel('b', { idOffset: 1000 }), visible: false };
    // B's flat meshes are already dropped from the drawn list; its instanced
    // occurrences are still in the scene.
    b.geometryResult = {
      instancedGeometryAabbs: new Map(WING.map((id) => [id, {}])),
    } as unknown as FederatedModel['geometryResult'];
    const hidden = modelHiddenEntities(new Map([['a', a], ['b', b]]), new Set(), (m, id) => (m === 'b' ? id + 1000 : id));
    assert.deepEqual(fit({ meshes: meshes(...BUILDING), visibility: { hidden, isolated: null } }), BUILDING_BOX);
  });

  it('a hidden model with flat meshes only is not framed, whatever the load-time box spans', () => {
    assert.deepEqual(fit({ meshes: meshes(...BUILDING), instancedIds: [], wholeScene: span(0, 9001) }), BUILDING_BOX);
  });

  it('a model moved after load is framed where it now is (placed bounds, no cached box)', () => {
    // The wing moved 500 m further east; boundsOf reports placed bounds.
    const moved = (id: number) => {
      const b = BOXES.get(id) ?? null;
      if (!b || id < 1001 || id > 1300) return b;
      return { min: { ...b.min, x: b.min.x + 500 }, max: { ...b.max, x: b.max.x + 500 } };
    };
    assert.deepEqual(fit({ boundsOf: moved }), span(0, 1530, 10));
  });

  it('leaves coordination-marker proxies out, flat and instanced, as the load-time fit does (#5633)', () => {
    // Two small proxy markers ~0.6 building lengths east: one flat mesh, one
    // instanced occurrence whose class comes from the store.
    const markers = new Map<number, BoundingBox3D>([[7001, box(49)], [7002, box(50)]]);
    const boundsOf = (id: number) => markers.get(id) ?? BOXES.get(id) ?? null;
    const input = {
      meshes: [...meshes(...BUILDING), { expressId: 7001, ifcType: 'IfcBuildingElementProxy' }],
      instancedIds: [7002],
      boundsOf,
    };
    assert.deepEqual(fit({ ...input, typeOf: () => 'IfcBuildingElementProxy' }), BUILDING_BOX);
    // A lamp post there is typed as what it is, so it stays framed.
    assert.deepEqual(
      fit({ ...input, meshes: [...meshes(...BUILDING), { expressId: 7001, ifcType: 'IfcLamp' }], typeOf: () => 'IfcLamp' }),
      span(0, 51, 10),
    );
  });

  it('Types view: the undrawn instanced occurrences are not framed', () => {
    assert.deepEqual(fit({ instancedDrawn: false }), BUILDING_BOX);
  });

  it('falls back to the load-time box when nothing visible has bounds', () => {
    assert.deepEqual(fit({ visibility: { hidden: NONE, isolated: new Set([424242]) } }), WHOLE);
  });

  it('ignores a non-finite box instead of framing garbage', () => {
    const bad = (id: number) => (id === 1 ? box(Number.NaN) : id === 2 ? box(0) : null);
    assert.deepEqual(fit({ meshes: meshes(1, 2, 3), instancedIds: [], boundsOf: bad, visibility: { hidden: NONE, isolated: new Set([1, 2]) } }), box(0));
  });

  it('the instanced pass is hidden only in the Types view of a model with a type library', () => {
    assert.equal(instancedPassDrawn({ hasTypeGeometry: true, typeViewMode: 'types' }), false);
    assert.equal(instancedPassDrawn({ hasTypeGeometry: true, typeViewMode: 'model' }), true);
    assert.equal(instancedPassDrawn({ hasTypeGeometry: false, typeViewMode: 'types' }), true);
  });
});
