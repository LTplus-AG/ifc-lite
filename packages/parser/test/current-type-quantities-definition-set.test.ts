/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7681 through the native current-model type quantity reader. Its relationship
 * inventory read attribute 5 as ONE number and refused ("relationship target
 * is unreadable") on anything else, so a single `IfcRelDefinesByProperties`
 * naming an `IfcPropertySetDefinitionSet`, anywhere in the file, made every
 * type quantity read in that file unavailable.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, readCurrentTypeQuantities } from '../src/index.js';
import type { MetadataReadView } from '../src/effective-metadata-record.js';

const gid = (n: number) => String(n).padStart(22, '0');
const NO_EDITS: MetadataReadView = {
  isDeleted: () => false, getNewEntities: () => [], getNewEntity: () => null,
  getPositionalMutationsForEntity: () => null, getAttributeMutationsForEntity: () => [], getMutationRevision: () => 0,
};

/** Wall type #20 typing wall #10; qset #21 (Qto_Probe) and pset #23 are attached to the type by `typeDefinition`. */
async function model(typeDefinition: string, extra: string[] = []) {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('t.ifc','2026-10-14T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
    `#1=IFCPROJECT('${gid(1)}',$,'P',$,$,$,$,$,#3);`, '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCUNITASSIGNMENT((#2));',
    `#10=IFCWALL('${gid(10)}',$,'W',$,$,$,$,$,$);`,
    `#20=IFCWALLTYPE('${gid(20)}',$,'WT',$,$,$,$,$,$,.STANDARD.);`,
    `#21=IFCELEMENTQUANTITY('${gid(21)}',$,'Qto_Probe',$,$,(#22));`,
    "#22=IFCQUANTITYLENGTH('Len',$,$,2.5,$);",
    `#23=IFCPROPERTYSET('${gid(23)}',$,'Pset_Probe',$,());`,
    `#30=IFCRELDEFINESBYTYPE('${gid(30)}',$,$,$,(#10),#20);`,
    `#31=IFCRELDEFINESBYPROPERTIES('${gid(31)}',$,$,$,(#20),${typeDefinition});`,
    ...extra,
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new IfcParser().parseColumnar(buffer, { disableWorkerScan: true });
}

const names = (store: Awaited<ReturnType<typeof model>>) =>
  readCurrentTypeQuantities(store, 10, NO_EDITS).value?.quantities.map((set) => set.name);

describe('current type quantities over an IfcPropertySetDefinitionSet (#7681)', () => {
  it.each([
    ['a single reference', '#21'],
    ['a bare set', '(#23,#21)'],
    ['a typed set', 'IFCPROPERTYSETDEFINITIONSET((#23,#21))'],
    ['a set that repeats a member', '(#21,#21,#23)'],
  ])('reads the quantity set the type carries through %s', async (_label, definition) => {
    const result = readCurrentTypeQuantities(await model(definition), 10, NO_EDITS);
    expect(result.reason).toBeNull();
    expect(result.status).toBe('available');
    expect(result.value?.quantities.map((set) => set.name)).toEqual(['Qto_Probe']);
  });

  it('a set-valued relationship elsewhere does not make every type read unavailable', async () => {
    const store = await model('#21', [
      `#40=IFCWALL('${gid(40)}',$,'Other',$,$,$,$,$,$);`,
      `#41=IFCRELDEFINESBYPROPERTIES('${gid(41)}',$,$,$,(#40),IFCPROPERTYSETDEFINITIONSET((#23)));`,
    ]);
    const result = readCurrentTypeQuantities(store, 10, NO_EDITS);
    expect(result.status).toBe('available');
    expect(names(store)).toEqual(['Qto_Probe']);
  });

  it('a stray number in a set is not a definition reference', async () => {
    // `(#21,1500)`: the decoded value cannot tell #1500 from 1500, and no entity #1500 exists.
    const result = readCurrentTypeQuantities(await model('(#21,1500)'), 10, NO_EDITS);
    expect(result.status).toBe('available');
    expect(result.value?.quantities.map((set) => set.name)).toEqual(['Qto_Probe']);
  });

  it('counts a set against the reference budget instead of expanding it unbounded', async () => {
    // 600 objects x 600 definitions is 360,000 edges, past the 262,144-reference limit.
    const definitions = Array.from({ length: 600 }, (_, i) => 1000 + i);
    const objects = Array.from({ length: 600 }, (_, i) => 3000 + i);
    const store = await model('#21', [
      ...definitions.map((id) => `#${id}=IFCPROPERTYSET('${gid(id)}',$,'P${id}',$,());`),
      ...objects.map((id) => `#${id}=IFCWALL('${gid(id)}',$,'O${id}',$,$,$,$,$,$);`),
      `#50=IFCRELDEFINESBYPROPERTIES('${gid(50)}',$,$,$,(${objects.map((id) => `#${id}`).join(',')}),(${definitions.map((id) => `#${id}`).join(',')}));`,
    ]);
    const result = readCurrentTypeQuantities(store, 10, NO_EDITS);
    expect(result.status).toBe('unavailable');
    expect(result.reason).toMatch(/exceed the read limit/);
  });
});
