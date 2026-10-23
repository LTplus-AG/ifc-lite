/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = new URL('../../../', import.meta.url);
const model = new URL('tests/models/ara3d/AC20-FZK-Haus.ifc', repo);
const expression = `bim.query().byType("IfcDoor").toArray().map(door => (
  bim.mutate.setAttribute(door.ref,"Name","DX CLI live door"),
  {GlobalId:door.globalId,
   Name:bim.attributes(door.ref).find(a=>a.name==="Name")?.value,
   queriedName:bim.query().byType("IfcDoor").toArray().find(other=>other.globalId===door.globalId)?.name,
   csv:bim.export.csv([door.ref],{columns:["Name"]})}
))`;
const result = spawnSync(process.execPath, [fileURLToPath(new URL('packages/cli/dist/index.js', repo)),
  'eval', fileURLToPath(model), expression, '--json'], { encoding: 'utf8', timeout: 60000 });
assert.equal(result.status, 0, result.stderr);
const { result: doors } = JSON.parse(result.stdout);
assert.equal(doors.length, 5);
for (const door of doors) {
  assert.equal(door.Name, 'DX CLI live door');
  assert.equal(door.queriedName, door.Name);
  assert.equal(door.csv, 'Name\nDX CLI live door');
}
writeFileSync(new URL('fzk.json', import.meta.url), JSON.stringify({
  fixture: 'ara3d/AC20-FZK-Haus.ifc',
  sha256: createHash('sha256').update(readFileSync(model)).digest('hex'),
  command: 'ifc-lite eval <fixture> <single expression> --json',
  doors,
}, null, 2) + '\n');
