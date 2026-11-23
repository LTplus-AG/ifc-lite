/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import type { BimContext } from '@ifc-lite/sdk';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { cleanup, render } from '@/test/render';
import { BimProvider, useBim } from './BimProvider';
import { createSdkStepWriter, StepExportUnavailableError } from './sdk-step-writer';

afterEach(() => {
  cleanup();
  useViewerStore.getState().resetViewerState();
});

async function seedModel() {
  const source = readFileSync(new URL('../../public/samples/hello-wall.ifc', import.meta.url));
  const ifcDataStore = await new IfcParser().parseColumnar(Uint8Array.from(source).buffer, { disableWorkerScan: true });
  useViewerStore.setState(fixtureModels({ ...fixtureModel('wall'), ifcDataStore }));
}

function mountSdk(stepWriter: ReturnType<typeof createSdkStepWriter>) {
  let bim!: BimContext;
  function Consumer() {
    bim = useBim();
    return <span>{bim.model.activeId()}</span>;
  }
  const ui = render(<BimProvider stepWriter={stepWriter}><Consumer /></BimProvider>);
  assert.equal(ui.textContent, 'wall', 'the viewer renders while STEP is loading');
  return bim;
}

async function queryHost(client: BroadcastChannel): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Viewer SDK did not respond')), 5000);
    client.onmessage = ({ data }) => {
      if (data.id !== id) return;
      clearTimeout(timeout);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    };
    client.postMessage({ id, namespace: 'model', method: 'activeId', args: [] });
  });
}

test('#11247 viewer and host work during and after a failed STEP import', async () => {
  await seedModel();
  let rejectImport!: (error: Error) => void;
  const pending = new Promise<typeof import('@/lib/export/step-export-runtime')>((_resolve, reject) => { rejectImport = reject; });
  const writer = createSdkStepWriter(() => pending);
  const bim = mountSdk(writer);
  const client = new BroadcastChannel('ifc-lite');
  try {
    assert.throws(() => bim.export.ifc(), { name: 'StepExportUnavailableError', reason: 'loading' });
    assert.equal(await queryHost(client), 'wall');
    const cause = new Error('chunk unavailable');
    rejectImport(cause);
    await assert.rejects(writer.load(), { name: 'StepExportUnavailableError', reason: 'load-failed', cause });
    assert.throws(() => bim.export.ifc(), (error: unknown) =>
      error instanceof StepExportUnavailableError && error.reason === 'load-failed' && error.cause === cause);
    assert.equal(bim.model.activeId(), 'wall');
    assert.equal(await queryHost(client), 'wall');
  } finally {
    client.close();
  }
});

test('#11247 useBim exports synchronously after its background import', async () => {
  await seedModel();
  let requested = false;
  const writer = createSdkStepWriter(() => {
    requested = true;
    return import('@/lib/export/step-export-runtime');
  });
  const bim = mountSdk(writer);
  assert.ok(requested, 'mount started the background import');
  await writer.load();
  const content = bim.export.ifc(undefined, { schema: 'IFC4' });
  const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
  assert.match(text, /FILE_SCHEMA\(\('IFC4'\)\)/);
  assert.match(text, /IFCWALL(?:STANDARDCASE)?\(/);
});
