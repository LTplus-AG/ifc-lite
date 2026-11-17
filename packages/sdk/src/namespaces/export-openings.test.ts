/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { IfcCreator } from '@ifc-lite/create';
import { parseModel } from '@ifc-lite/parser';
import { createBimContext } from '../context.js';
import { HeadlessBackend } from '../headless/backend.js';

// #9423 round 2: SDK/MCP CSV and JSON must agree with CLI schedule dimensions.
it.each(['Door', 'Window', 'DoorStandardCase', 'WindowStandardCase'].flatMap(type => [undefined, 1.1].map(width => ({ type, width }))))('exports opening dimensions with quantity precedence: %o', async ({ type, width }) => {
  const family = type.startsWith('Door') ? 'Door' : 'Window';
  const c = new IfcCreator();
  const quantity = width === undefined ? '' : `
#9001=IFCQUANTITYLENGTH('Width',$,$,${width},$);
#9002=IFCELEMENTQUANTITY('0Qto_A_0000000000000001',$,'Qto_${family}BaseQuantities',$,$,(#9001));
#9003=IFCRELDEFINESBYPROPERTIES('0Rel_A_0000000000000001',$,$,$,(#9000),#9002);`;
  const source = c.toIfc().content.replace('ENDSEC;\nEND-ISO-10303-21;', `#9000=IFC${type.toUpperCase()}('0Door_A_00000000000001',$,'D1',$,$,$,$,'D-01',2.1,0.9,.${family.toUpperCase()}.,$,$);${quantity}\nENDSEC;\nEND-ISO-10303-21;`);
  const { store } = await parseModel(new TextEncoder().encode(source), { disableWorkerScan: true });
  const backend = new HeadlessBackend(store, 'test', 'default');
  if (type.endsWith('StandardCase')) backend.getOrCreateMutationView().setEntityType(9000, `Ifc${type}`, null, `Ifc${family}`);
  const bim = createBimContext({ backend });
  const entity = bim.query().byType(`Ifc${type}`).toArray()[0];
  if (type.endsWith('StandardCase')) expect(entity.type).toBe(`Ifc${type}`);
  const ref = entity.ref;
  const columns = [`Qto_${family}BaseQuantities.Width`, `Qto_${family}BaseQuantities.Height`];
  expect(bim.export.csv([ref], { columns }).split('\n')[1]).toBe(`${width ?? .9},2.1`);
  expect(bim.export.json([ref], columns)).toEqual([{ [columns[0]]: width ?? .9, [columns[1]]: 2.1 }]);
});
