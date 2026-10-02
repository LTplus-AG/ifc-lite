/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: direct canonical writer evidence for late schema refusals.
 * The CLI native suite separately proves the full built sibling graph. */
import { describe, expect, it } from 'vitest';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { IfcCreator } from '../ifc-creator.js';
import { addMaterialLayerSetToStore, addMaterialToStore } from './material.js';
import { resolveAuthoringAnchor } from './resolve-relations.js';

async function parse(content: Uint8Array) {
  return new IfcParser().parseColumnar(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer, { disableWorkerScan: true });
}
async function records(content: Uint8Array) {
  const store = await parse(content), extractor = new EntityExtractor(store.source);
  return [...store.entityIndex.byId].map(([id, location]) => [id, extractor.extractEntity(location)] as const).sort((a, b) => a[0] - b[0]);
}

describe('#6232 canonical material-layer schema refusal', () => {
  for (const millimetres of [false, true]) for (const lateField of ['layer', 'set'] as const) {
    it(`IFC2X3/${millimetres ? 'mm' : 'm'}: late ${lateField} Description preserves the earlier graph and allocator`, async () => {
      const creator = new IfcCreator({ Schema: 'IFC2X3', LengthUnit: millimetres ? 'MILLIMETRE' : 'METRE', Timestamp: 0 });
      creator.addIfcBuildingStorey({ Name: 'Direct schema refusal', Elevation: 0 });
      const store = await parse(new TextEncoder().encode(creator.toIfc().content));
      expect(store.schemaVersion).toBe('IFC2X3');
      expect(store.lengthUnitScale).toBe(millimetres ? .001 : 1);
      const view = new MutablePropertyView(store.properties, 'direct'), editor = new StoreEditor(store, view);
      const anchor = resolveAuthoringAnchor(store, view);
      const concrete = addMaterialToStore(editor, anchor, { Name: 'Concrete' }).materialId;
      const wool = addMaterialToStore(editor, anchor, { Name: 'Wool' }).materialId;
      editor.addEntity('IfcCartesianPoint', [[7, 8, 9]]);
      const save = () => new StepExporter(store, view).export({ applyMutations: true }).content;
      const before = await records(save()), journal = view.getMutations(), next = view.peekNextExpressId();
      const layers = [
        { Material: concrete, LayerThickness: .2 },
        { Material: wool, LayerThickness: .1, ...(lateField === 'layer' ? { Description: 'Unsupported second-layer field' } : {}) },
      ];
      expect(() => addMaterialLayerSetToStore(editor, anchor, {
        MaterialLayers: layers, LayerSetName: 'Refused set',
        ...(lateField === 'set' ? { Description: 'Unsupported set field' } : {}),
      })).toThrow(new Error(`addMaterialLayerSetToStore: IfcMaterial${lateField === 'layer' ? 'Layer' : 'LayerSet'} has no attribute Description in IFC2X3`));
      expect(await records(save())).toEqual(before);
      expect(view.getMutations()).toEqual(journal);
      expect(view.peekNextExpressId()).toBe(next);
    });
  }
});
