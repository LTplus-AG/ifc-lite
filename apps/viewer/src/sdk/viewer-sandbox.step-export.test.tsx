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
import { BimProvider, useBim } from './BimProvider';
import type { BimContext } from '@ifc-lite/sdk';
import { createViewerSandbox } from '@/lib/scripts/viewer-sandbox';

afterEach(() => {
  cleanup();
  useViewerStore.getState().resetViewerState();
});

test('#11247 an export-enabled sandbox can export synchronously in its first script', async () => {
  const source = readFileSync(new URL('../../public/samples/hello-wall.ifc', import.meta.url));
  const ifcDataStore = await new IfcParser().parseColumnar(Uint8Array.from(source).buffer, { disableWorkerScan: true });
  useViewerStore.setState(fixtureModels({ ...fixtureModel('wall'), ifcDataStore }));
  const captured: { bim?: BimContext } = {};
  function Capture() {
    captured.bim = useBim();
    return null;
  }
  render(<BimProvider><Capture /></BimProvider>);
  assert.ok(captured.bim);
  const sandbox = await createViewerSandbox(captured.bim);
  try {
    const result = await sandbox.eval(`
      const content = bim.export.ifc(undefined, { schema: 'IFC4' });
      typeof content === 'string' ? content : content.map(byte => String.fromCharCode(byte)).join('');
    `, { typescript: false });
    assert.equal(typeof result.value, 'string');
    assert.match(String(result.value), /FILE_SCHEMA\(\('IFC4'\)\)/);
    assert.match(String(result.value), /IFCWALL(?:STANDARDCASE)?\(/);
  } finally {
    sandbox.dispose();
  }
});
