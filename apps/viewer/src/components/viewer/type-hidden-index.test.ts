/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type visibility as ids (#10264). The reference is the per-mesh rule the
 * viewport used to filter its upload with (`isMeshVisibleInViewMode` and
 * `isMeshTypeVisible`): for every combination, an entity is hidden exactly when
 * that rule drops its meshes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { TYPE_VISIBILITY_SEMANTIC_DEFAULTS } from '@/store/constants';
import type { StructuralViewMode, TypeVisibility } from '@/store/types';
import { isMeshTypeVisible, type RetypedClasses } from '@/store/typeVisibilityFilter';
import { isMeshVisibleInViewMode, type TypeViewMode } from '@/lib/type-view-visibility';
import { TypeHiddenIndex, withTypeHidden, type TypeHiddenSettings } from './type-hidden-index.js';

const mesh = (expressId: number, ifcType: string, geometryClass?: number, entityIds?: Uint32Array): MeshData => ({
  expressId, ifcType, geometryClass, entityIds,
  positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
}) as MeshData;

const allOn: TypeVisibility = { ...TYPE_VISIBILITY_SEMANTIC_DEFAULTS, spaces: true, spatialZones: true, openings: true,
  virtualElements: true, site: true, ifcAnnotations: true };
const settings = (over: Partial<TypeHiddenSettings> = {}): TypeHiddenSettings => ({
  typeVisibility: allOn, viewMode: 'model', hasOccurrenceGeometry: true, structuralViewMode: 'both', ...over });

/** The old upload filter, applied per mesh: the ids it would have dropped. */
function referenceHidden(meshes: readonly MeshData[], s: TypeHiddenSettings): number[] {
  const hidden = new Set<number>();
  for (const m of meshes) {
    const shown = isMeshVisibleInViewMode(m.geometryClass ?? 0, s.viewMode, s.hasOccurrenceGeometry)
      && isMeshTypeVisible(m, s.typeVisibility, s.structuralViewMode, s.retyped);
    if (!shown) hidden.add(m.expressId);
  }
  return [...hidden].sort((a, b) => a - b);
}
const sorted = (ids: Iterable<number>) => [...ids].sort((a, b) => a - b);

// A model with every class the toggles gate, an analytical member, orphan and
// instanced type-library geometry and a layer slice, with federated-style ids.
const meshes = [
  mesh(1_000_001, 'IfcWall'), mesh(1_000_001, 'IfcWall'), mesh(1_000_002, 'IfcSpace'),
  mesh(1_000_003, 'IfcOpeningElement'), mesh(1_000_004, 'IfcOpeningStandardCase'), mesh(1_000_005, 'IfcVirtualElement'),
  mesh(1_000_006, 'IfcSite'), mesh(1_000_007, 'IfcGeographicElement'), mesh(1_000_008, 'IfcAnnotation'),
  mesh(1_000_009, 'IfcSpatialZone'), mesh(1_000_010, 'IfcStructuralCurveMember'), mesh(1_000_011, 'IfcBeam'),
  mesh(1_000_012, 'IfcWallType', 1), mesh(1_000_013, 'IfcBeamType', 2), mesh(1_000_014, 'IfcSlab', 3),
];

describe('TypeHiddenIndex', () => {
  it('hides exactly what the per-mesh upload filter dropped, for every toggle, view and structural mode', () => {
    const keys = ['spaces', 'spatialZones', 'openings', 'virtualElements', 'site', 'ifcAnnotations'] as const;
    const index = new TypeHiddenIndex();
    let checked = 0;
    for (const viewMode of ['model', 'types'] as TypeViewMode[]) {
      for (const structuralViewMode of ['both', 'physical', 'analytical'] as StructuralViewMode[]) {
        for (const hasOccurrenceGeometry of [true, false]) {
          for (let mask = 0; mask < 1 << keys.length; mask++) {
            const typeVisibility = { ...allOn };
            keys.forEach((key, bit) => { typeVisibility[key] = (mask & (1 << bit)) === 0; });
            const s = settings({ typeVisibility, viewMode, structuralViewMode, hasOccurrenceGeometry });
            assert.deepEqual(sorted(index.update(meshes, s).ids), referenceHidden(meshes, s), JSON.stringify(s));
            checked++;
          }
        }
      }
    }
    assert.equal(checked, 2 * 3 * 2 * 64);
  });

  it('follows a retype by the entity\'s class after the edit (#10119)', () => {
    const retyped: RetypedClasses = new Map([[1_000_011, 'IfcStructuralCurveMember'], [1_000_001, 'IfcSpace']]);
    const index = new TypeHiddenIndex();
    for (const s of [settings({ retyped, structuralViewMode: 'analytical' }),
      settings({ retyped, typeVisibility: { ...allOn, spaces: false } })]) {
      assert.deepEqual(sorted(index.update(meshes, s).ids), referenceHidden(meshes, s));
    }
    const s = settings({ retyped, typeVisibility: { ...allOn, spaces: false } });
    assert.ok(index.update(meshes, s).ids.has(1_000_001), 'a wall retyped to a space hides with the spaces');
  });

  it('grows with streamed batches as a new set each time, leaving the previous one as it was', () => {
    const index = new TypeHiddenIndex();
    const stream: MeshData[] = [];
    const s = settings({ typeVisibility: { ...allOn, spaces: false, openings: false } });
    let previous = index.update(stream, s);
    for (let i = 0; i < meshes.length; i += 4) {
      const before = sorted(previous.ids);
      stream.push(...meshes.slice(i, i + 4));
      const next = index.update(stream, s);
      assert.deepEqual(sorted(next.ids), referenceHidden(stream, s));
      if (next.ids.size > before.length) {
        assert.notEqual(next.ids, previous.ids, 'a batch that hides more is a new set (identity-keyed memos see it)');
        assert.ok(next.version > previous.version);
      }
      assert.deepEqual(sorted(previous.ids), before, 'the set a consumer holds is never written');
      previous = next;
    }
    assert.equal(index.update(stream, s), previous, 'an unchanged list and settings return the same object');
    const toggled = index.update(stream, settings());
    assert.notEqual(toggled.ids, previous.ids, 'a toggle builds a new set');
    assert.deepEqual(sorted(toggled.ids), referenceHidden(stream, settings()), 'only the type library stays hidden in Model view');
  });

  it('indexes a replaced or shortened list from scratch', () => {
    const index = new TypeHiddenIndex();
    const s = settings({ typeVisibility: { ...allOn, spaces: false } });
    assert.ok(index.update(meshes, s).ids.has(1_000_002));
    const replaced = meshes.filter((m) => m.ifcType !== 'IfcSpace');
    const ids = index.update(replaced, s).ids;
    assert.ok(!ids.has(1_000_002), 'a removed space no longer counts as hidden');
    assert.deepEqual(sorted(ids), referenceHidden(replaced, s));
    assert.deepEqual(sorted(index.update(replaced.slice(0, 2), s).ids), [], 'a shorter list is indexed again');
  });

  it('hides every entity a hidden colour-merged mesh carries in its vertex lane', () => {
    const merged = mesh(7, 'IfcSpace', 0, new Uint32Array([7, 7, 8, 8, 9, 7]));
    const ids = new TypeHiddenIndex().update([merged, mesh(10, 'IfcWall')], settings({ typeVisibility: { ...allOn, spaces: false } })).ids;
    assert.deepEqual(sorted(ids), [7, 8, 9]);
  });

  it('keeps the orphan-type rule of #1353 as occurrences stream in after the type library', () => {
    const index = new TypeHiddenIndex();
    const orphan = [mesh(5, 'IfcWallType', 1)];
    assert.equal(index.update(orphan, settings({ hasOccurrenceGeometry: false })).ids.size, 0, 'a pure type library stays visible');
    const both = [...orphan, mesh(6, 'IfcWall')];
    assert.deepEqual(sorted(index.update(both, settings({ hasOccurrenceGeometry: true })).ids), [5]);
  });
});

describe('withTypeHidden', () => {
  it('leaves the user\'s set untouched and returns it when type visibility hides nothing', () => {
    const user = new Set([1, 2]);
    assert.equal(withTypeHidden(user, { ids: new Set(), version: 1 }), user);
    const union = withTypeHidden(user, { ids: new Set([2, 3]), version: 2 });
    assert.deepEqual(sorted(union), [1, 2, 3]);
    assert.deepEqual(sorted(user), [1, 2], 'the user\'s hidden set is never written');
  });
});
