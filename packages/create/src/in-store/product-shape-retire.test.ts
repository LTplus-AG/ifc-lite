/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcCreator } from '../ifc-creator.js';
import { retireProductShape } from '../index.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { addWallToStore } from './wall.js';
import { refId } from './host-geometry-frame.js';

async function wallSession() {
  const creator = new IfcCreator({ Schema: 'IFC4', LengthUnit: 'MILLIMETRE' });
  const storey = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(creator.toIfc().content).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storey, view);
  const first = addWallToStore(editor, anchor, { Start: [0, 0, 0], End: [5, 0, 0], Height: 3, Thickness: 0.2 }).wallId;
  const second = addWallToStore(editor, anchor, { Start: [5, 0, 0], End: [5, 4, 0], Height: 3, Thickness: 0.2 }).wallId;
  const reader = new AnchorEntityReader(store, view);
  const shapeOf = (id: number) => refId(reader.entity(id)?.attributes[6]);
  const exported = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
  return { store, view, editor, first, second, shapeOf, exported };
}

describe('retireProductShape (#10960)', () => {
  it('removes a removed product\'s shape and representations, keeping the context', async () => {
    const { store, editor, first, second, shapeOf, exported } = await wallSession();
    const shape = shapeOf(first)!;
    const before = exported().match(/IFCSHAPEREPRESENTATION\(/g)?.length ?? 0;
    editor.removeEntity(first);
    const removed = retireProductShape(store, editor, shape);
    expect(removed[0]).toBe(shape);
    const step = exported();
    expect(step).not.toMatch(new RegExp(`^#${shape}=`, 'm'));
    expect(step.match(/IFCSHAPEREPRESENTATION\(/g)?.length ?? 0).toBeLessThan(before);
    expect(step).toMatch(/IFCGEOMETRICREPRESENTATIONCONTEXT\(/);
    expect(shapeOf(second)).not.toBeNull();
  });

  it('keeps a shape another product still uses', async () => {
    const { store, editor, first, second, shapeOf } = await wallSession();
    const shape = shapeOf(first)!;
    editor.setPositionalAttribute(second, 6, `#${shape}`);
    editor.removeEntity(first);
    expect(retireProductShape(store, editor, shape)).toEqual([]);
    expect(shapeOf(second)).toBe(shape);
  });
});
