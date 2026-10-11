/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assertSameNativeIfcGraph } from './native-ifc-graph';

const source = readFileSync(new URL('../../public/samples/building-architecture.ifc', import.meta.url), 'utf8');
const bytes = (text: string) => new TextEncoder().encode(text);
function changed(before: string, after: string): Uint8Array {
  assert.ok(source.includes(before), 'the real SketchUp fixture must contain the native control');
  return bytes(source.replace(before, after));
}

test('#7347 complete parsed native comparison preserves the graph across an export timestamp difference', async () => {
  const later = changed('2024-11-14T11:09:12', '2024-11-14T11:09:13');
  assert.notDeepEqual(later, bytes(source), 'this is an actual IFC header difference');
  await assertSameNativeIfcGraph(later, bytes(source));
});

for (const [kind, before, after] of [
  ['schema', "FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC2X3'))"],
  ['entity identity', '#291=IFCWALL(', '#900001=IFCWALL('],
  ['entity type', '#291=IFCWALL(', '#291=IFCWALLSTANDARDCASE('],
  ['full native attributes', 'A solid outer wall, forming the right back side of the house.', 'A different native Description'],
  ['additional entity', 'ENDSEC;\nEND-ISO-10303-21;', "#900001=IFCMATERIAL('Unexpected native material',$,$);\nENDSEC;\nEND-ISO-10303-21;"],
] as const) test(`#7347 parsed native comparison refuses changed ${kind}`, async () => {
  await assert.rejects(assertSameNativeIfcGraph(changed(before, after), bytes(source)), { name: 'AssertionError' });
});
