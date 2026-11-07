/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withAuthoredStyles } from './authored-style-wire';

type Entity = { type: string; expressId: number; attributes: unknown[] };

function viewOf(entities: Entity[]) {
  const byId = new Map(entities.map((e) => [e.expressId, e]));
  return { getNewEntities: () => entities, getNewEntity: (id: number) => byId.get(id) ?? null };
}

const empty = { styleIds: new Uint32Array(), styleColors: new Uint8Array() };

const glazing: Entity[] = [
  { type: 'IfcColourRgb', expressId: 10, attributes: [null, { real: 0.5 }, { real: 1 }, { real: 0 }] },
  { type: 'IfcSurfaceStyleShading', expressId: 11, attributes: ['#10', { real: 0.75 }] },
  { type: 'IfcSurfaceStyle', expressId: 12, attributes: ['Glass', '.BOTH.', ['#11']] },
  { type: 'IfcStyledItem', expressId: 13, attributes: ['#100', ['#12'], null] },
];

describe('withAuthoredStyles', () => {
  it('turns an authored styled item into a wire entry, transparency as alpha', () => {
    const wire = withAuthoredStyles(empty, viewOf(glazing), new Set([100]));
    assert.deepEqual([...wire.styleIds], [100]);
    assert.deepEqual([...wire.styleColors], [128, 255, 0, 64]);
  });

  it('reads through the IFC2X3 style assignment', () => {
    const ifc2x3: Entity[] = [
      ...glazing.slice(0, 3),
      { type: 'IfcPresentationStyleAssignment', expressId: 14, attributes: [['#12']] },
      { type: 'IfcStyledItem', expressId: 13, attributes: ['#100', ['#14'], null] },
    ];
    const wire = withAuthoredStyles(empty, viewOf(ifc2x3), new Set([100]));
    assert.deepEqual([...wire.styleColors], [128, 255, 0, 64]);
  });

  it('leaves out items that are not in the re-meshed subgraph', () => {
    const wire = withAuthoredStyles(empty, viewOf(glazing), new Set([999]));
    assert.equal(wire.styleIds.length, 0);
  });

  it('keeps the entry the file already gave an item', () => {
    const file = { styleIds: Uint32Array.of(100), styleColors: Uint8Array.of(1, 2, 3, 4) };
    const wire = withAuthoredStyles(file, viewOf(glazing), new Set([100]));
    assert.deepEqual([...wire.styleIds], [100]);
    assert.deepEqual([...wire.styleColors], [1, 2, 3, 4]);
  });

  it('appends after the file entries', () => {
    const file = { styleIds: Uint32Array.of(7), styleColors: Uint8Array.of(1, 2, 3, 4) };
    const wire = withAuthoredStyles(file, viewOf(glazing), new Set([7, 100]));
    assert.deepEqual([...wire.styleIds], [7, 100]);
    assert.deepEqual([...wire.styleColors], [1, 2, 3, 4, 128, 255, 0, 64]);
  });

  it('returns the wire untouched with no view, or an unreadable style chain', () => {
    assert.equal(withAuthoredStyles(empty, null, new Set([100])), empty);
    const broken: Entity[] = [{ type: 'IfcStyledItem', expressId: 13, attributes: ['#100', ['#404'], null] }];
    assert.equal(withAuthoredStyles(empty, viewOf(broken), new Set([100])), empty);
  });
});
