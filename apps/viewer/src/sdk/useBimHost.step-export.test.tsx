/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { cleanup, render } from '@/test/render';
import { BimProvider } from './BimProvider';

afterEach(() => {
  cleanup();
  useViewerStore.getState().resetViewerState();
});

test('#11247 first BroadcastChannel IFC export writes the loaded model', async () => {
  const source = readFileSync(new URL('../../public/samples/hello-wall.ifc', import.meta.url));
  const ifcDataStore = await new IfcParser().parseColumnar(Uint8Array.from(source).buffer, { disableWorkerScan: true });
  useViewerStore.setState(fixtureModels({ ...fixtureModel('wall'), ifcDataStore }));
  render(<BimProvider><span /></BimProvider>);
  const client = new BroadcastChannel('ifc-lite');
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Viewer SDK did not respond')), 5000);
      client.onmessage = ({ data }) => {
        if (data.id !== 'cold-step') return;
        clearTimeout(timeout);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
      };
      client.postMessage({ id: 'cold-step', namespace: 'export', method: 'ifc', args: [undefined, { schema: 'IFC4' }] });
    });
    assert.ok(typeof result === 'string' || result instanceof Uint8Array);
    const text = typeof result === 'string' ? result : new TextDecoder().decode(result);
    assert.match(text, /FILE_SCHEMA\(\('IFC4'\)\)/);
    assert.match(text, /IFCWALL(?:STANDARDCASE)?\(/);
  } finally {
    client.close();
  }
});
