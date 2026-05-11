/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage for the long-tail entity ops not exercised by `schema.test.ts`:
 * materials, classifications, quantities, attribute deletion idempotence,
 * and the `iterEntities` helper.
 */

import { describe, expect, it } from 'vitest';
import {
  addClassification,
  addMaterial,
  createEntity,
  deleteAttribute,
  deletePropertyValue,
  entityToJSON,
  iterEntities,
  setQuantityValue,
} from '../src/doc/entity.js';
import { createCollabDoc, entitiesMap } from '../src/doc/schema.js';
import { setPropertyValue } from '../src/doc/entity.js';

describe('long-tail entity ops', () => {
  it('addMaterial preserves order and full payload', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    addMaterial(doc, 'wall', { materialId: 'concrete', thickness: 0.2 });
    addMaterial(doc, 'wall', { materialId: 'insulation', thickness: 0.05, fraction: 0.95 });
    const json = entityToJSON(entitiesMap(doc).get('wall')!);
    expect(json.materials).toEqual([
      { materialId: 'concrete', thickness: 0.2 },
      { materialId: 'insulation', thickness: 0.05, fraction: 0.95 },
    ]);
  });

  it('addClassification appends in order', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    addClassification(doc, 'wall', { system: 'Uniclass', code: 'Pr_30' });
    addClassification(doc, 'wall', { system: 'OmniClass', code: '23-13', uri: 'https://example' });
    const json = entityToJSON(entitiesMap(doc).get('wall')!);
    expect(json.classifications).toEqual([
      { system: 'Uniclass', code: 'Pr_30' },
      { system: 'OmniClass', code: '23-13', uri: 'https://example' },
    ]);
  });

  it('setQuantityValue stores values nested by qset/qty name', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'slab');
    setQuantityValue(doc, 'slab', 'Qto_SlabBaseQuantities', 'GrossArea', 12.5);
    setQuantityValue(doc, 'slab', 'Qto_SlabBaseQuantities', 'NetVolume', 0.625);
    const ent = entitiesMap(doc).get('slab')!;
    const qsets = ent.get('quantities') as import('yjs').Map<import('yjs').Map<number>>;
    const qto = qsets.get('Qto_SlabBaseQuantities')!;
    expect(qto.get('GrossArea')).toBe(12.5);
    expect(qto.get('NetVolume')).toBe(0.625);
  });

  it('deleteAttribute is idempotent and tells the truth', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    expect(deleteAttribute(doc, 'wall', 'Name')).toBe(false);
    expect(deleteAttribute(doc, 'missing', 'Name')).toBe(false);
  });

  it('deletePropertyValue cleans up empty psets', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall');
    setPropertyValue(doc, 'wall', 'Pset_WallCommon', 'FireRating', { type: 'IfcLabel', value: 'EI60' });
    expect(deletePropertyValue(doc, 'wall', 'Pset_WallCommon', 'FireRating')).toBe(true);
    const ent = entitiesMap(doc).get('wall')!;
    const psets = ent.get('psets') as import('yjs').Map<unknown>;
    expect(psets.has('Pset_WallCommon')).toBe(false);
  });

  it('iterEntities returns every live entity', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'a');
    createEntity(doc, 'b');
    createEntity(doc, 'c');
    const seen = new Set<string>();
    for (const [path] of iterEntities(doc)) seen.add(path);
    expect(seen).toEqual(new Set(['a', 'b', 'c']));
  });
});
