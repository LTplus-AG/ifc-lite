/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { clashDisciplineCandidates } from './clash-taxonomy';

function pair(tagA: string, tagB: string) {
  return { a: { tag: tagA, model: 'architecture', key: 'same-guid', ref: 1 },
    b: { tag: tagB, model: 'services', key: 'same-guid', ref: 1_000_001 } };
}

// #6844: type-selector overlap must not silently become a project responsibility.
test('native wall/pipe overlaps remain ambiguous and retain side identity', () => {
  const input = pair('IfcWall', 'IfcPipeSegment');
  const before = structuredClone(input);
  assert.deepEqual(clashDisciplineCandidates(input), { a: ['ARCH', 'STR'], b: ['MEP', 'FIRE'] });
  assert.deepEqual(input, before, 'enrichment never rewrites native references');
  assert.deepEqual(clashDisciplineCandidates({ a: input.b, b: input.a }),
    { a: ['MEP', 'FIRE'], b: ['ARCH', 'STR'] });
});

test('unknown types remain unknown while native suffix selectors and casing work', () => {
  assert.deepEqual(clashDisciplineCandidates(pair('IfcBuildingElementProxy', 'IFCDUCTSEGMENT')),
    { a: [], b: ['HVAC'] });
  assert.deepEqual(clashDisciplineCandidates(pair('', 'IfcCableCarrierSegment')),
    { a: [], b: ['ELEC'] });
});

test('committed SketchUp model wall tags use native candidates without a fabricated mapping', async () => {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const { IfcParser } = await import('@ifc-lite/parser');
  const bytes = await readFile(resolve(process.cwd(), 'public/samples/building-architecture.ifc'));
  assert.match(bytes.subarray(0, 4000).toString(), /SketchUp/);
  const store = await new IfcParser().parseColumnar(Uint8Array.from(bytes).buffer, { disableWorkerScan: true });
  const ids = store.entityIndex.byType.get('IFCWALL') ?? [];
  assert.ok(ids.length > 0, 'the real authoring fixture must contain walls');
  for (const id of ids) {
    const tag = store.entities.getTypeName(id);
    assert.equal(tag, 'IfcWall');
    assert.deepEqual(clashDisciplineCandidates(pair(tag, 'IfcBuildingElementProxy')),
      { a: ['ARCH', 'STR'], b: [] });
  }
});
