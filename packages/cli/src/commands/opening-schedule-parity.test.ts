/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { parseModel } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { IfcCreator } from '@ifc-lite/create';
import { HeadlessBackend } from '../headless-backend.js';
import { resolveColumnValue } from './export.js';
import { resolveScheduleValue } from './schedule.js';

it.each(['Door', 'Window', 'DoorStandardCase', 'WindowStandardCase'])('schedules %s dimensions, mark and common properties without a quantity set (#9354)', async type => {
  const family = type.startsWith('Door') ? 'Door' : 'Window';
  const c = new IfcCreator();
  const source = c.toIfc().content.replace('ENDSEC;\nEND-ISO-10303-21;', `#9000=IFC${type.toUpperCase()}('0Door_A_00000000000001',$,'D1',$,$,$,$,'D-01',2.1,0.9,.${family.toUpperCase()}.,$,$);\nENDSEC;\nEND-ISO-10303-21;`);
  const { store } = await parseModel(new TextEncoder().encode(source), { disableWorkerScan: true });
  const backend = new HeadlessBackend(store, 'test');
  const bim = createBimContext({ backend });
  let entity = bim.query().byType(`Ifc${type}`).toArray()[0];
  expect(entity).toBeDefined();
  bim.mutate.setProperty(entity.ref, `Pset_${family}Common`, 'FireRating', 'EI60');
  bim.mutate.setProperty(entity.ref, `Pset_${family}Common`, 'IsExternal', true);
  if (type.endsWith('StandardCase')) {
    backend.getMutationView()!.setEntityType(entity.ref.expressId, `Ifc${type}`, null, `Ifc${family}`);
    entity = bim.query().byType(`Ifc${type}`).toArray()[0];
    expect(entity.type).toBe(`Ifc${type}`);
  }
  expect(resolveColumnValue(entity, `Qto_${family}BaseQuantities.Width`, bim)).toBe(.9);
  expect(resolveColumnValue(entity, `Qto_${family}BaseQuantities.Height`, bim)).toBe(2.1);
  expect(resolveScheduleValue(entity, `Qto_${family}BaseQuantities.Width`, bim)).toBe(.9);
  expect(resolveScheduleValue(entity, `Qto_${family}BaseQuantities.Height`, bim)).toBe(2.1);
  expect(resolveScheduleValue(entity, 'Tag', bim)).toBe('D-01');
  expect(resolveScheduleValue(entity, `Pset_${family}Common.FireRating`, bim)).toBe('EI60');
  expect(resolveScheduleValue(entity, `Pset_${family}Common.IsExternal`, bim)).toBe(true);
});
