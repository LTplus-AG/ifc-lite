/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { IfcCreator } from '../../ifc-creator.js';
import { addOrdinaryElementInStore } from '../ordinary-element.js';
import { AnchorEntityReader, resolveSpatialAnchor } from '../resolve-anchor.js';
import { applyFrame, placementInAncestor, refId } from '../host-geometry-frame.js';
import { parse, session } from '../__test__/storey-fixtures.oracle.js';
import { addStoreyInStore } from './storey-add.js';
import { attachedTopWorldOrigin, levelTopFaceAbove, readAttachedTop } from './storey-attached.js';
import { NEXT_STOREY_ABOVE, writeTopAttachment } from './storey-attachment.js';
import { applyStoreyDelete, planStoreyDelete } from './storey-delete.js';
import { readStoreyInventory } from './storey-model.js';

for (const kind of ['beam', 'member'] as const) {
  for (const fit of [
    { name: 'upward collapse', start: [0, 0, -3], end: [0, 0, -1], refused: true },
    { name: 'downward collapse', start: [0, 0, -1], end: [0, 0, -3], refused: true },
    { name: 'upward slope past foot', start: [0, 0, -2], end: [2, 0, 0], refused: true },
    { name: 'downward slope past foot', start: [2, 0, 0], end: [0, 0, -2], refused: true },
    { name: 'rolled section not square after refit', start: [0, 0, -6], end: [2, 0, -4], refDirection: [1, 0, -1], refused: true },
    { name: 'valid vertical', start: [0, 0, -6], end: [0, 0, -2], refused: false },
    { name: 'valid slope', start: [0, 0, -6], end: [2, 0, -4], refused: false },
    { name: 'valid level', start: [0, 0, -3], end: [2, 0, -3], refused: false },
  ]) {
    it.each([false, true])(`#9352 deletion preview agrees with a pending ${kind} ${fit.name} refit (reopen=%s)`, async reopen => {
      const creator = new IfcCreator({ Name: 'Linear deletion preview' });
      creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
      let s = session(await parse(creator.toIfc().content));
      const lower = readStoreyInventory(s.store, s.view).storeys[0].expressId;
      addStoreyInStore(s.store, s.editor, { Name: 'Middle', Elevation: 3 });
      const home = addStoreyInStore(s.store, s.editor, { Name: 'Top', Elevation: 6 }).storeyId;
      const id = addOrdinaryElementInStore(s.editor, draft => resolveSpatialAnchor(s.store, home, draft.getMutationView()),
        { kind, params: { Start: [fit.start[0], fit.start[1], fit.start[2]], End: [fit.end[0], fit.end[1], fit.end[2]], Width: .3, Height: .3 } });
      if (fit.refDirection !== undefined) {
        const reader = new AnchorEntityReader(s.store, s.view);
        const placement = reader.entity(refId(reader.entity(id)!.attributes[5])!)!;
        const axis = refId(placement.attributes[1])!;
        const direction = s.editor.addEntity('IfcDirection', [fit.refDirection]).expressId;
        s.editor.setPositionalAttribute(axis, 2, `#${direction}`);
      }
      writeTopAttachment(s.view, id, NEXT_STOREY_ABOVE, 'relative');
      if (reopen) s = session(await parse(s.text()));
      const before = s.snapshot(), mode = { kind: 'move' as const, targetStoreyId: lower };
      const plan = planStoreyDelete(readStoreyInventory(s.store, s.view), home, mode);
      expect(s.snapshot()).toEqual(before);
      if (fit.refused) {
        expect(plan.refusals).toEqual([expect.objectContaining({ code: 'dependent', elementIds: [id] })]);
        expect(() => applyStoreyDelete(s.store, s.editor, home, mode, plan)).toThrow(/long|foot|square/);
        expect(s.snapshot()).toEqual(before);
      } else {
        expect(plan.refusals).toEqual([]);
        applyStoreyDelete(s.store, s.editor, home, mode, plan);
        const check = () => {
          // Independent solid/placement oracle: no attachment-top helper in
          // this calculation. The fixture has a centred 0.3 m rectangle.
          const reader = new AnchorEntityReader(s.store, s.view);
          const product = reader.entity(id)!;
          const shape = reader.entity(refId(product.attributes[6])!)!;
          const representations = shape.attributes[2];
          if (!Array.isArray(representations)) throw new Error('Expected representations');
          const representation = representations.map(refId).filter((value): value is number => value !== null)
            .map(value => reader.entity(value)!).find(value => value.attributes[1] === 'Body')!;
          const items = representation.attributes[3];
          if (!Array.isArray(items)) throw new Error('Expected one body solid');
          const solid = reader.entity(refId(items[0])!)!;
          expect(solid.type.toUpperCase()).toBe('IFCEXTRUDEDAREASOLID');
          const length = solid.attributes[3];
          if (typeof length !== 'number') throw new Error('Expected extrusion depth');
          const frame = placementInAncestor(reader, refId(product.attributes[5])!, null)!;
          if (fit.name === 'valid level') {
            const corners = [-.15, .15].flatMap(x => [-.15, .15].flatMap(y => [0, length].map(z => applyFrame(frame, [x, y, z]))));
            expect(Math.max(...corners.map(point => point[2]))).toBeCloseTo(3, 8);
          } else {
            // Sloping/vertical members constrain their upper axis endpoint.
            expect(Math.max(frame.o[2], applyFrame(frame, [0, 0, length])[2])).toBeCloseTo(3, 8);
          }
          const target = { dataStore: s.store, view: s.view, editor: s.editor };
          expect(readAttachedTop(target, id, 'linear')! + attachedTopWorldOrigin(target, id, 'linear')!
            + levelTopFaceAbove(target, id, 'linear')).toBeCloseTo(3, 8);
        };
        check();
        s = session(await parse(s.text()));
        check();
      }
    });
  }
}
