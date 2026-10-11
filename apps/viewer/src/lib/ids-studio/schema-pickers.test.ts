/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS-033 / IDS-034: picker options come from the gate's own schema tables.
 * Oracle: whatever a picker offers, the grounding gate accepts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkOps, createStudioDocument } from '@ifc-lite/ids-authoring';
import { loadStudioContexts } from './context';
import { addFacetOps, addSpecOps } from './ops';
import { attributeOptions, dataTypeOptions, entityOptions, findEntity, propertyOptions, psetOptions } from './schema-pickers';

describe('schema pickers (IDS-033, IDS-034)', () => {
  it('lists entities with their supertypes and flags abstract classes', async () => {
    const { gate } = await loadStudioContexts();
    const options = entityOptions(gate, ['IFC4']);
    const wall = options.find((o) => o.name === 'IfcWall');
    assert.ok(wall);
    assert.equal(wall.abstract, false);
    assert.equal(wall.ancestors[0], 'IfcBuildingElement');
    assert.ok(wall.predefinedTypes.includes('SOLIDWALL'));
    assert.equal(options.find((o) => o.name === 'IfcBuildingElement')?.abstract, true);
    assert.ok(options.length > 700, 'the whole IFC4 entity table, pre-indexed');
  });

  it('offers only names present in every version of the spec', async () => {
    const { gate } = await loadStudioContexts();
    assert.ok(findEntity(gate, ['IFC4X3_ADD2'], 'IfcBuiltElement'));
    assert.equal(findEntity(gate, ['IFC4', 'IFC4X3_ADD2'], 'IfcBuiltElement'), undefined);
    assert.ok(!entityOptions(gate, ['IFC2X3', 'IFC4']).some((o) => o.name === 'IfcBuiltElement'));
  });

  it('filters property sets to those applicable to the applicability entities, and shows all on request', async () => {
    const { gate } = await loadStudioContexts();
    const filtered = psetOptions(gate, ['IFC4'], ['IFCWALL'], false);
    assert.ok(filtered.some((p) => p.name === 'Pset_WallCommon' && p.applicable));
    assert.ok(!filtered.some((p) => p.name === 'Pset_DoorCommon'), 'a door set is not offered for walls');
    const all = psetOptions(gate, ['IFC4'], ['IFCWALL'], true);
    assert.ok(all.some((p) => p.name === 'Pset_DoorCommon' && !p.applicable));
    assert.ok(all.findIndex((p) => !p.applicable) > all.findIndex((p) => p.applicable), 'applicable sets sort first');
    assert.ok(propertyOptions(gate, ['IFC4'], 'Pset_WallCommon').some((p) => p.name === 'FireRating' && p.dataType === 'IFCLABEL'));
  });

  it('every offered entity, pset, property and data type passes the grounding gate', async () => {
    const { gate } = await loadStudioContexts();
    const doc = createStudioDocument({ title: 'Oracle' });
    const spec = addSpecOps({ name: 'S', ifcVersions: ['IFC4'] });
    const concrete = entityOptions(gate, ['IFC4']).filter((o) => !o.abstract).slice(0, 60);
    for (const entity of concrete) {
      const ops = [...spec.ops, ...addFacetOps(spec.specId, 'applicability', { type: 'entity', name: { kind: 'equals', value: entity.name } }).ops];
      assert.equal(checkOps(ops, doc, gate).ok, true, entity.name);
    }
    const wallSpec = [...spec.ops, ...addFacetOps(spec.specId, 'applicability', { type: 'entity', name: { kind: 'equals', value: 'IfcWall' } }).ops];
    for (const pset of psetOptions(gate, ['IFC4'], ['IFCWALL'], false)) {
      for (const property of propertyOptions(gate, ['IFC4'], pset.name)) {
        const facet = addFacetOps(spec.specId, 'requirements', {
          type: 'property', propertySet: { kind: 'equals', value: pset.name }, baseName: { kind: 'equals', value: property.name },
          ...(property.dataType ? { dataType: { kind: 'equals' as const, value: property.dataType } } : {}),
        });
        const result = checkOps([...wallSpec, ...facet.ops], doc, gate);
        assert.equal(result.ok, true, `${pset.name}.${property.name}: ${result.issues.map((i) => i.message).join('; ')}`);
      }
    }
    for (const attribute of attributeOptions(gate, ['IFC4'], ['IFCWALL'])) {
      const facet = addFacetOps(spec.specId, 'requirements', { type: 'attribute', name: { kind: 'equals', value: attribute } });
      assert.equal(checkOps([...wallSpec, ...facet.ops], doc, gate).ok, true, attribute);
    }
    assert.ok(dataTypeOptions(gate, ['IFC4']).includes('IFCLENGTHMEASURE'));
  });
});
