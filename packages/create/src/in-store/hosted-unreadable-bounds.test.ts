/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #6232 / #6539: explicit unreadable geometry must never become default axes
 * or a smaller partial body. Actual Bonsai opening #1299 is mapped geometry. */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { readHostOpeningExtents, addHostedElementInStore } from './hosted-element.js';
import { placedBodyExtent } from './resolve-host.js';

async function session(brokenSource: boolean | '2D direction' = false) {
  const source = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url), 'utf8');
  const content = brokenSource === '2D direction'
    ? source.replace('#1342=IFCDIRECTION((1.,0.,0.));', '#1342=IFCDIRECTION((1.,0.));')
    : brokenSource ? source.replace('#1343=IFCAXIS2PLACEMENT3D(#1340,#1341,#1342);', '#1343=IFCAXIS2PLACEMENT3D(#1340,#1341,#999999);') : source;
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(content).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  return { store, view, editor: new StoreEditor(store, view) };
}

function refuses(s: Awaited<ReturnType<typeof session>>) {
  const before = s.view.getMutations();
  expect(placedBodyExtent(s.store, 1299, s.view)).toBeNull();
  expect(readHostOpeningExtents(s.store, 1222, s.view).unreadable).toContain(1299);
  expect(() => addHostedElementInStore(s.store, s.editor, 1222, { kind: 'door', params: { Offset: 8, Width: 0.9, Height: 2.1 } })).toThrow(/cannot be read/);
  expect(s.view.getMutations()).toEqual(before);
}

describe('#6232 / #6539 conservative hosted bounds', () => {
  it('refuses an explicit missing opening RefDirection from actual source IFC', async () => refuses(await session(true)));

  it('refuses a source 2D direction used by IfcAxis2Placement3D instead of padding it', async () => refuses(await session('2D direction')));

  for (const axisId of [1343, 1318, 1311]) {
    for (const attribute of [0, 1, 2]) {
      for (const dimension of [2, 4]) {
        it(`refuses ${dimension} components at 3D placement #${axisId} attribute ${attribute}`, async () => {
          const s = await session();
          const values = attribute === 1 ? (dimension === 2 ? [0, 1] : [0, 0, 1, 1])
            : dimension === 2 ? [1, 0] : [1, 0, 0, 1];
          const record = s.editor.addEntity(attribute === 0 ? 'IfcCartesianPoint' : 'IfcDirection', [values]).expressId;
          s.editor.setPositionalAttribute(axisId, attribute, `#${record}`);
          refuses(s);
        });
      }
    }
  }

  for (const id of [1320, 1321, 1322]) {
    it(`refuses a 2D vector in the mapping target's 3D record #${id}`, async () => {
      const s = await session();
      s.editor.setPositionalAttribute(id, 0, id === 1322 ? [0, 1] : [1, 0]);
      refuses(s);
    });
  }

  for (const axisId of [1343, 1318, 1311]) {
    for (const fault of ['missing Axis', 'missing RefDirection', 'zero Axis', 'zero RefDirection', 'parallel axes'] as const) {
      it(`refuses ${fault} in source opening/mapping/solid placement #${axisId}`, async () => {
        const s = await session();
        if (fault.startsWith('missing')) s.editor.setPositionalAttribute(axisId, fault === 'missing Axis' ? 1 : 2, '#999999');
        else {
          const direction = s.editor.addEntity('IfcDirection', [fault === 'parallel axes' ? [0, 0, 1] : [0, 0, 0]]).expressId;
          s.editor.setPositionalAttribute(axisId, fault === 'zero Axis' ? 1 : 2, `#${direction}`);
          if (fault === 'parallel axes') s.editor.setPositionalAttribute(axisId, 1, `#${direction}`);
        }
        refuses(s);
      });
    }
  }

  it('keeps legitimate omitted optional opening and mapping orientation readable', async () => {
    const s = await session();
    for (const id of [1343, 1318]) {
      s.editor.setPositionalAttribute(id, 1, null);
      s.editor.setPositionalAttribute(id, 2, null);
    }
    // Independently authored IFC: #1305 is [0,.899999976158142] ×
    // [0,1.20000004768372]; #1311 rotates profile Y to Z and starts
    // at Y=-.600000023841858; #1313 extrudes 1.2 along +Y.
    // Identity #1318/#1324 mapping then #1340 adds [1.76767492294312,0,1].
    const bounds = placedBodyExtent(s.store, 1299, s.view);
    expect(bounds).not.toBeNull();
    const expected = {
      min: [1.76767492294312, -0.600000023841858, 1],
      max: [2.667674899101262, 0.599999976158142, 2.20000004768372],
    };
    for (const side of ['min', 'max'] as const) for (let axis = 0; axis < 3; axis++) {
      expect(bounds![side][axis]).toBeCloseTo(expected[side][axis], 12);
    }
    expect(readHostOpeningExtents(s.store, 1222, s.view).unreadable).toEqual([]);
    expect(addHostedElementInStore(s.store, s.editor, 1222, { kind: 'door', params: { Offset: 8, Width: 0.9, Height: 2.1 } }).openingId).toBeGreaterThan(0);
  });

  it('refuses a malformed profile point instead of filtering it out', async () => {
    const s = await session();
    s.editor.setPositionalAttribute(1305, 0, [[0, 0], [0.9, 0], ['bad', 1.2], [0, 1.2]]);
    refuses(s);
  });

  it('refuses an unreadable representation instead of returning only another body', async () => {
    const s = await session();
    s.editor.setPositionalAttribute(1327, 2, ['#1326', '#999999']);
    refuses(s);
  });

  for (const fault of ['missing placement', 'missing direction', 'zero direction'] as const) {
    it(`refuses an explicit ${fault} in a rectangular profile's 2D Position`, async () => {
      const s = await session();
      const point = s.editor.addEntity('IfcCartesianPoint', [[0.45, 0.6]]).expressId;
      const direction = s.editor.addEntity('IfcDirection', [[0, 0]]).expressId;
      const position = s.editor.addEntity('IfcAxis2Placement2D', [`#${point}`, fault === 'zero direction' ? `#${direction}` : '#999999']).expressId;
      const profile = s.editor.addEntity('IfcRectangleProfileDef', ['.AREA.', null, fault === 'missing placement' ? '#999999' : `#${position}`, 0.9, 1.2]).expressId;
      s.editor.setPositionalAttribute(1313, 0, `#${profile}`);
      refuses(s);
    });
  }

  it('keeps omitted optional rectangle Position readable', async () => {
    const s = await session();
    const profile = s.editor.addEntity('IfcRectangleProfileDef', ['.AREA.', null, null, 0.9, 1.2]).expressId;
    s.editor.setPositionalAttribute(1313, 0, `#${profile}`);
    expect(placedBodyExtent(s.store, 1299, s.view)).not.toBeNull();
    expect(readHostOpeningExtents(s.store, 1222, s.view).unreadable).toEqual([]);
  });

  it('keeps an explicit valid 2D rectangle Position and RefDirection readable', async () => {
    const s = await session();
    const point = s.editor.addEntity('IfcCartesianPoint', [[0.45, 0.6]]).expressId;
    const direction = s.editor.addEntity('IfcDirection', [[1, 0]]).expressId;
    const position = s.editor.addEntity('IfcAxis2Placement2D', [`#${point}`, `#${direction}`]).expressId;
    const profile = s.editor.addEntity('IfcRectangleProfileDef', ['.AREA.', null, `#${position}`, 0.9, 1.2]).expressId;
    s.editor.setPositionalAttribute(1313, 0, `#${profile}`);
    expect(placedBodyExtent(s.store, 1299, s.view)).not.toBeNull();
    expect(readHostOpeningExtents(s.store, 1222, s.view).unreadable).toEqual([]);
    expect(addHostedElementInStore(s.store, s.editor, 1222, { kind: 'door', params: { Offset: 8, Width: 0.9, Height: 2.1 } }).openingId).toBeGreaterThan(0);
  });
});
