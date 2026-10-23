/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Copy beside the generated project's package.json before executing so imports
// resolve its npm installation, independently of the source workspace.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { IfcParser } from '@ifc-lite/parser';

const path = process.argv[2];
if (!path || !existsSync(path)) {
  console.log('SKIP: FZK reference fixture is absent; run pnpm fixtures');
  process.exit(0);
}
const bytes = readFileSync(path);
const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const store = await new IfcParser().parseColumnar(input);
const doors = store.entityIndex.byType.get('IFCDOOR') ?? [];
assert.equal(store.schemaVersion, 'IFC4');
assert.equal(doors.length, 5);
assert.equal(new Set(doors.map(id => store.entities.getGlobalId(id))).size, 5);
console.log(JSON.stringify({ schema: store.schemaVersion, IfcDoor: doors.length,
  sha256: createHash('sha256').update(bytes).digest('hex') }));
