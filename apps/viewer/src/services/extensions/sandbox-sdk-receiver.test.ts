/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBimContext } from '@ifc-lite/sdk';
import { ExtensionRuntime, parseCapabilities, type Bundle } from '@ifc-lite/extensions';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { seedArtifactModels } from '@/test/artifact-models-fixture';
import { createBimSandboxFactory } from './sandbox-factory';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
async function nativeRuntime(grants: string[]) {
  await seedArtifactModels();
  const sdk = createBimContext({ backend: new LocalBackend(useViewerStore) });
  const capabilities = parseCapabilities(grants); assert.ok(capabilities.ok);
  const runtime = new ExtensionRuntime({ sdk, factory: createBimSandboxFactory({ sdk }) });
  const id = 'com.campaign.sdk-receiver';
  const bundle: Bundle = { manifest: { manifestVersion: 1, id, name: id, description: 'Native receiver regression',
    version: '1.0.0', engines: { ifcLiteSdk: '>=2.0.0' }, capabilities: grants, activation: [], entry: {} }, files: new Map() };
  const record = await runtime.activate(id, capabilities.value, bundle);
  return { runtime, sandbox: record.sandbox, id };
}

test('#7172 granted native SDK query returns actual authored IFC identities through QuickJS', async () => {
  const native = await nativeRuntime(['model.read']);
  try {
    const result = await native.sandbox.run("JSON.stringify(bim.query.byType('IfcWall').map(wall => ({GlobalId:wall.GlobalId,Name:wall.Name})))");
    assert.equal(typeof result.value, 'string');
    const walls = JSON.parse(String(result.value)) as Array<{ GlobalId: string; Name: string }>;
    assert.equal(walls.length, 4);
    assert.equal(new Set(walls.map(wall => wall.GlobalId)).size, 4);
    assert.ok(walls.every(wall => wall.Name && wall.GlobalId.length === 22));
  } finally { await native.runtime.deactivate(native.id); }
});

test('#7172 granted native attribute convenience method preserves its SDK receiver', async () => {
  const native = await nativeRuntime(['model.read']);
  try {
    const result = await native.sandbox.run("const wall = bim.query.byType('IfcWall')[0]; JSON.stringify({GlobalId:wall.GlobalId,attributes:bim.query.attributes(wall)})");
    const output = JSON.parse(String(result.value)) as { GlobalId: string; attributes: Array<{ name: string; value: string }> };
    const store = useViewerStore.getState().models.get('arch')?.ifcDataStore; assert.ok(store);
    const id = store.entities.getExpressIdByGlobalId(output.GlobalId); assert.ok(id > 0);
    assert.equal(output.attributes.find(attribute => attribute.name === 'Name')?.value, store.getEntity(id)?.attributes[2]);
  } finally { await native.runtime.deactivate(native.id); }
});

test('#7172 ungranted native IFC queries remain refused by bridge permissions', async () => {
  const native = await nativeRuntime([]);
  try {
    assert.equal((await native.sandbox.run('typeof bim.query')).value, 'undefined', 'read namespace is not installed without permission');
    await assert.rejects(native.sandbox.run("bim.query.byType('IfcWall')"), /byType.*undefined/);
    assert.equal(useViewerStore.getState().mutationVersion, 0);
  } finally { await native.runtime.deactivate(native.id); }
});

test('#7172 public viewer methods retain fine-grained denial despite another viewer grant', async () => {
  const native = await nativeRuntime(['model.read', 'viewer.colorize']);
  const hidden = useViewerStore.getState().hiddenEntities;
  try {
    await assert.rejects(native.sandbox.run('bim.viewer.hide([])'), /Capability denied.*viewer\.hide/);
    assert.equal(useViewerStore.getState().hiddenEntities, hidden);
    assert.equal(useViewerStore.getState().mutationVersion, 0);
  } finally { await native.runtime.deactivate(native.id); }
});
