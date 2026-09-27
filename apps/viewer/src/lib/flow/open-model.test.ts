/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `model.openFromSource` in the viewer (#5634): the run hands the node the
 * viewer's `openModel`, which loads the bytes through `addModel` (the
 * canonical `loadFile` pipeline) under a sanitized name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BimContext } from '@ifc-lite/sdk';
import { MemoCache, type FlowDocument } from '@ifc-lite/flow';
import { runFlowInViewer } from './runner.js';
import { createViewerOpenModel, type AddModel } from './open-model.js';

const IFC = new TextEncoder().encode('ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\nÿ');

function recordingAddModel(result: 'ok' | 'null-registered' | 'fail') {
  const calls: Array<{ name: string; bytes: number[]; options?: { name?: string; modelId?: string } }> = [];
  const registered = new Set<string>();
  const addModel: AddModel = async (file, options) => {
    calls.push({ name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())), options });
    if (result === 'fail') return null;
    registered.add(options!.modelId!);
    return result === 'ok' ? options!.modelId! : null;
  };
  return { calls, addModel, isRegistered: (id: string) => registered.has(id) };
}

const graph: FlowDocument = {
  flowVersion: 1, id: 'g', name: 'g', capabilities: ['model.create'], inputs: [], outputs: [],
  nodes: [
    // base64 of `IFC` above
    { id: 'src', type: 'core.string', params: { value: Buffer.from(IFC).toString('base64') } },
    { id: 'open', type: 'model.openFromSource', params: { name: '../plan<A>.ifc' } },
  ],
  edges: [{ from: ['src', 'value'], to: ['open', 'data'] }],
};

const bim = {
  model: { activeId: () => 'm0' },
  mutate: { batchAsync: async <T>(_label: string, fn: () => Promise<T>) => fn() },
} as unknown as BimContext;

describe('model.openFromSource in the viewer', () => {
  it('loads the downloaded bytes through addModel and outputs the new model id', async () => {
    const add = recordingAddModel('ok');
    const result = await runFlowInViewer({
      doc: graph, bim, pin: 'p', cache: new MemoCache(),
      openModel: createViewerOpenModel(add.addModel, add.isRegistered),
    });
    assert.deepEqual(result.log.filter((l) => l.level === 'error'), []);
    assert.equal(add.calls.length, 1);
    assert.deepEqual(add.calls[0].bytes, Array.from(IFC));
    // The remote name is sanitized once and used for both the File and the model.
    assert.equal(add.calls[0].name, add.calls[0].options?.name);
    assert.doesNotMatch(add.calls[0].name, /[/<>]/);
    const out = result.outputs.get('open')?.get('modelId');
    assert.deepEqual(out, { kind: 'item', value: add.calls[0].options?.modelId });
  });

  it('treats a model registered under a superseded load session as loaded', async () => {
    const add = recordingAddModel('null-registered');
    const opened = await createViewerOpenModel(add.addModel, add.isRegistered)(IFC, 'a.ifc');
    assert.equal(opened.modelId, add.calls[0].options?.modelId);
  });

  it('fails the node when the model never registered', async () => {
    const add = recordingAddModel('fail');
    await assert.rejects(createViewerOpenModel(add.addModel, add.isRegistered)(IFC, 'a.ifc'), /a\.ifc could not be loaded/);
  });
});
