/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { createOrdinaryStoreBackend, createBimContext, type BimBackend, type BimContext, type EntityRef } from '@ifc-lite/sdk';
import { buildStoreNamespace } from './bridge-store.js';

let sdk: BimContext, editor: StoreEditor, view: MutablePropertyView;
let sourceBytes: () => Uint8Array;
beforeEach(async () => {
  const bytes = readFileSync(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  sourceBytes = () => store.source.slice(0, store.source.byteLength);
  view = new MutablePropertyView(null, 'm');
  editor = new StoreEditor(store, view);
  // Only the real ordinary SDK namespace is used; unrelated backend
  // capabilities are deliberately absent from this focused integration.
  sdk = createBimContext({ backend: { store: createOrdinaryStoreBackend(() => ({ modelId: 'm', store, editor, mutationView: view })) } as BimBackend });
});
const invoke = (method: string, params: object) => buildStoreNamespace().methods.find(candidate => candidate.name === method)!.call(sdk, ['m', 42, params], { sandboxSessionId: '#6232-profile' }) as EntityRef;

for (const method of ['addColumn', 'addBeam', 'addMember']) {
  it(`bridge ${method} authoring accepts canonical circular/hollow profiles without rectangular dimensions (#6232)`, () => {
    const placement = method === 'addColumn' ? { Position: [20,20,0], Height: 3, RefDirection: [0,1,0] } : { Start: [20,20,0], End: [24,20,0] };
    for (const Profile of [{ Type: 'Circle', Radius: .2 }, { Type: 'RectangleHollow', XDim: .3, YDim: .4, WallThickness: .02 }]) {
      const ref = invoke(method, { ...placement, Profile, Name: `Bridge ${Profile.Type}` });
      const record = editor.getNewEntity(ref.expressId)!;
      expect(record.type).toBe(`Ifc${method.slice(3)}`);
      expect(record.attributes[2]).toBe(`Bridge ${Profile.Type}`);
      const profileClass = Profile.Type === 'Circle' ? 'IfcCircleProfileDef' : 'IfcRectangleHollowProfileDef';
      const referenced = (value: unknown) => {
        if (typeof value !== 'string' || !/^#\d+$/.test(value)) throw new Error('Expected an IFC entity reference');
        return editor.getNewEntity(Number(value.slice(1)))!;
      };
      const representation = referenced(record.attributes[6]);
      const shapes = representation.attributes[2];
      if (!Array.isArray(shapes)) throw new Error('Expected IfcProductDefinitionShape.Representations');
      const body = referenced(shapes[0]), items = body.attributes[3];
      if (!Array.isArray(items)) throw new Error('Expected IfcShapeRepresentation.Items');
      const solid = referenced(items[0]), section = referenced(solid.attributes[0]);
      expect(section.type).toBe(profileClass);
      const value = (slot: unknown) => slot && typeof slot === 'object' && 'real' in slot ? slot.real : slot;
      if ('Radius' in Profile) expect(value(section.attributes[3])).toBe(Profile.Radius);
      else expect(section.attributes.slice(3, 6).map(value)).toEqual([Profile.XDim, Profile.YDim, Profile.WallThickness]);
    }
  });
  it(`bridge ${method} retains rectangular authoring and invalid canonical profile rollback (#6232)`, () => {
    const placement = method === 'addColumn' ? { Position: [20,20,0], Height: 3, Width: .3, Depth: .4 } : { Start: [20,20,0], End: [24,20,0], Width: .3, Height: .4 };
    invoke(method, placement);
    const before = structuredClone({ records: editor.getNewEntities(), journal: view.getMutations(), source: sourceBytes() }), next = view.peekNextExpressId();
    // #6760 review 4175954704: a profile-only request reaches thickness
    // validation instead of failing earlier on rectangular/Profile exclusivity.
    const profilePlacement = method === 'addColumn' ? { Position: [20,20,0], Height: 3 } : { Start: [20,20,0], End: [24,20,0] };
    expect(() => invoke(method, { ...profilePlacement, Profile: { Type: 'CircleHollow', Radius: .2, WallThickness: .3 } })).toThrow(/WallThickness must be less than Radius/);
    expect({ records: editor.getNewEntities(), journal: view.getMutations(), source: sourceBytes() }).toEqual(before);
    expect(view.peekNextExpressId()).toBe(next);
  });
}
