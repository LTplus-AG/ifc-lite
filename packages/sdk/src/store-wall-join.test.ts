/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: public SDK namespace -> canonical join -> schema/export proof. */
import { describe, expect, it } from 'vitest';
import { IfcCreator, addWallToStore, resolveSpatialAnchor, readWallJoinRels } from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createModellingStoreBackend } from './store-modelling-backend.js';
import { StoreNamespace } from './namespaces/store.js';
import type { BimBackend } from './types.js';

describe('#6232 public SDK wall join', () => {
  for (const Schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
    it(`exports the canonical ${Schema} relationship and millimetre body references`, async () => {
      const creator = new IfcCreator({ Schema, LengthUnit: 'MILLIMETRE' });
      const storey = creator.addIfcBuildingStorey({ Name: 'Level 0', Elevation: 0 });
      const store = await new IfcParser().parseColumnar(new TextEncoder().encode(creator.toIfc().content).buffer, { disableWorkerScan: true });
      const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
      const anchor = resolveSpatialAnchor(store, storey, view);
      const a = addWallToStore(editor, anchor, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3, Axis: true }).wallId;
      const b = addWallToStore(editor, anchor, { Start: [4, 0, 0], End: [4, 3, 0], Thickness: 0.2, Height: 3, Axis: true }).wallId;
      const methods = createModellingStoreBackend(id => {
        if (id !== 'm') throw new Error('Unknown model');
        return { modelId: 'm', store, view, mutationView: view, editor, ownerHistoryId: anchor.ownerHistoryId };
      });
      // Only the store namespace is exercised; every method is the real factory.
      const sdk = new StoreNamespace({ store: methods } as unknown as BimBackend);
      const door = sdk.addHostedDoor('m', a, { Offset: 1, Width: 0.9, Height: 2.1 });
      const rel = sdk.joinWalls('m', a, b, { Name: 'L corner' });
      expect(rel.modelId).toBe('m');
      expect(view.getNewEntity(rel.expressId)?.type).toBe('IfcRelConnectsPathElements');
      expect(view.getNewEntity(rel.expressId)?.attributes).toHaveLength(11);
      expect(readWallJoinRels(store, view)[0].name).toBe('L corner');
      expect(view.getNewEntity(door.expressId)?.attributes[9]).toBeCloseTo(900, 9);
      const bytes = new StepExporter(store, view).export({ schema: Schema, applyMutations: true }).content;
      const parsed = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
      expect(parsed.entityIndex.byType.get('IFCRELCONNECTSPATHELEMENTS')).toContain(rel.expressId);
      // Unsupported schemas and wrong model routing fail without removing the existing join.
      const before = view.getMutations();
      expect(() => sdk.joinWalls('other', a, b)).toThrow(/Unknown model/);
      store.schemaVersion = 'IFC5';
      expect(() => sdk.joinWalls('m', a, b)).toThrow(/IFC5/);
      expect(view.getMutations()).toEqual(before);
      expect(readWallJoinRels(store, view)).toHaveLength(1);
    });
  }
});
