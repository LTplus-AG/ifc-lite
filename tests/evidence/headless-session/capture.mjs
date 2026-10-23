/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { openModel, HeadlessSessionClosedError } from '../../../packages/sdk/dist/headless.js';

const fixture = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
const bytes = readFileSync(new URL('../../models/ara3d/AC20-FZK-Haus.ifc', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../../models/manifest.json', import.meta.url), 'utf8'));
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256, manifest.files.find(entry => entry.path === 'ara3d/AC20-FZK-Haus.ifc').sha256);
const source = await openModel(bytes, { modelId: 'architecture', disableWorkerScan: true });
let receipt;
try {
  assert.equal(source.report.completeness, 'complete');
  const doors = source.bim.query().byType('IfcDoor').toArray();
  assert.equal(doors.length, 5);
  const target = doors[0];
  source.bim.mutate.setProperty(target.ref, 'DX_Acceptance', 'Status', 'verified', 'IfcLabel');
  const exported = source.bim.export.ifc();
  const reopened = await openModel(typeof exported === 'string' ? new TextEncoder().encode(exported) : exported, { disableWorkerScan: true });
  try {
    const match = reopened.bim.query().byType('IfcDoor').toArray().find(door => door.globalId === target.globalId);
    assert.ok(match);
    assert.equal(reopened.bim.property(match.ref, 'DX_Acceptance', 'Status'), 'verified');
    receipt = { fixture, sha256, doors: doors.length, targetGlobalId: target.globalId,
      scanCompleteness: source.report.completeness, exportedEditReopened: true,
      capabilities: [source.capability('query.entities'), source.capability('viewer.colorize')],
      scope: 'Headless data/query/mutation/export/lifetime workflow; no geometry or schema-validation claim' };
  } finally { reopened.close(); }
} finally { source.close(); }
assert.throws(() => source.bim.query().toArray(), HeadlessSessionClosedError);
receipt.closedSessionRefused = true;
writeFileSync(new URL('./fzk.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
