/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFile } from 'node:fs/promises';
import { withModelFile } from './common.mjs';

const output = process.argv[3] ?? 'edited.ifc';
const identity = await withModelFile(process.argv[2] ?? 'model.ifc', async model => {
  const door = model.bim.query().byType('IfcDoor').toArray()[0];
  if (!door?.globalId) throw new Error('The input needs an IfcDoor with a GlobalId for this recipe');
  model.bim.mutate.setProperty(door.ref, 'DX_Example', 'Checked', true, 'IfcBoolean');
  await writeFile(output, model.bim.export.ifc());
  return door.globalId;
});
await withModelFile(output, model => {
  const door = model.bim.query().byType('IfcDoor').toArray().find(candidate => candidate.globalId === identity);
  if (!door || model.bim.property(door.ref, 'DX_Example', 'Checked') !== true)
    throw new Error('The exported edit did not survive reopening');
  console.log(JSON.stringify({ output, GlobalId: identity, Checked: true }));
});
