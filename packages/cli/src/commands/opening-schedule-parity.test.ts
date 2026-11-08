/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { parseModel } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { IfcCreator } from '@ifc-lite/create';
import { HeadlessBackend } from '../headless-backend.js';
import { resolveScheduleValue } from './schedule.js';

it.each(['Door', 'Window'])('schedules %s dimensions, mark and common properties without a quantity set (#9354)', async type => {
  const c = new IfcCreator();
  const source = c.toIfc().content.replace('ENDSEC;\nEND-ISO-10303-21;', `#9000=IFC${type.toUpperCase()}('0Door_A_00000000000001',$,'D1',$,$,$,$,'D-01',2.1,0.9,.${type.toUpperCase()}.,$,$);\nENDSEC;\nEND-ISO-10303-21;`);
  const { store } = await parseModel(new TextEncoder().encode(source), { disableWorkerScan: true });
  const bim = createBimContext({ backend: new HeadlessBackend(store, 'test') });
  const entity = bim.query().byType(`Ifc${type}`).toArray()[0];
  expect(entity).toBeDefined();
  bim.mutate.setProperty(entity.ref, `Pset_${type}Common`, 'FireRating', 'EI60');
  bim.mutate.setProperty(entity.ref, `Pset_${type}Common`, 'IsExternal', true);
  expect(resolveScheduleValue(entity, `Qto_${type}BaseQuantities.Width`, bim)).toBe(.9);
  expect(resolveScheduleValue(entity, `Qto_${type}BaseQuantities.Height`, bim)).toBe(2.1);
  expect(resolveScheduleValue(entity, 'Tag', bim)).toBe('D-01');
  expect(resolveScheduleValue(entity, `Pset_${type}Common.FireRating`, bim)).toBe('EI60');
  expect(resolveScheduleValue(entity, `Pset_${type}Common.IsExternal`, bim)).toBe(true);
});
