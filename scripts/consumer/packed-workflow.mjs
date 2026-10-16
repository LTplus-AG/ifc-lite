/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { Console } from 'node:console';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Standalone consumer process: stdout is the receipt, diagnostics use stderr.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const installedRoot = new URL('./node_modules/', import.meta.url).href;
for (const name of ['@ifc-lite/sdk/headless', '@ifc-lite/parser', '@ifc-lite/geometry']) {
  assert.ok(import.meta.resolve(name).startsWith(installedRoot), `${name} must resolve inside the consumer install`);
}
const { openModel, UnsupportedOperationError } = await import('@ifc-lite/sdk/headless');
const { GeometryProcessor } = await import('@ifc-lite/geometry');
const [file, type, expectedText] = process.argv.slice(2);
const bytes = await readFile(file);
const expected = Number(expectedText);
const model = await openModel(bytes, { modelId: 'packed-consumer', disableWorkerScan: true });
let reopened;
const processor = new GeometryProcessor({ enableInstancing: false });
try {
  assert.equal(model.report.completeness, 'complete');
  assert.equal(model.store.schemaVersion, 'IFC4');
  const query = model.bim.query().byType(type);
  const entities = query.toArray();
  assert.equal(entities.length, expected);
  const target = entities[0];
  assert.ok(target?.globalId);
  model.bim.mutate.setProperty(target.ref, 'DX_Packed', 'Status', 'verified', 'IfcLabel');
  reopened = await openModel(new TextEncoder().encode(model.bim.export.ifc()), { disableWorkerScan: true });
  const roundTrip = reopened.bim.query().byType(type).toArray();
  assert.equal(roundTrip.length, expected);
  const same = roundTrip.find(entity => entity.globalId === target.globalId);
  assert.ok(same);
  assert.equal(reopened.bim.property(same.ref, 'DX_Packed', 'Status'), 'verified');
  assert.equal(model.capability('viewer.flyTo').supported, false);
  assert.throws(() => model.bim.viewer.flyTo([target.ref]), error =>
    error instanceof UnsupportedOperationError && error.code === 'UNSUPPORTED_OPERATION');
  await processor.init();
  const geometry = await processor.process(bytes);
  assert.ok(geometry.meshes.length > 0);
  const glb = processor.exportGlbFromMeshes(geometry.meshes);
  assert.ok(glb);
  const envelope = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  assert.equal(envelope.getUint32(0, true), 0x46546c67);
  assert.equal(envelope.getUint32(4, true), 2);
  assert.equal(envelope.getUint32(8, true), glb.byteLength);
  model.close();
  assert.throws(() => query.toArray(), { code: 'SESSION_CLOSED' });
  process.stdout.write(JSON.stringify({ runtime: process.version, schema: model.store.schemaVersion,
    completeness: model.report.completeness, type, count: entities.length, GlobalId: target.globalId,
    artifactResolution: true, editReopened: true, unsupportedRefused: true, closedQueryRefused: true,
    meshes: geometry.meshes.length, triangles: geometry.meshes.reduce((count, mesh) => count + mesh.indices.length / 3, 0),
    glbBytes: glb.byteLength, glbSha256: createHash('sha256').update(glb).digest('hex') }) + '\n');
} finally {
  model.close();
  reopened?.close();
  processor.dispose();
}
