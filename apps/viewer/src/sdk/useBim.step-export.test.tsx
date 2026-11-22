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
import { cleanup, render, waitFor } from '@/test/render';
import { BimProvider, useBim } from './BimProvider';

afterEach(() => {
  cleanup();
  useViewerStore.getState().resetViewerState();
});

test('#11247 useBim exports STEP synchronously when a cold provider first mounts', async () => {
  const source = readFileSync(new URL('../../public/samples/hello-wall.ifc', import.meta.url));
  const ifcDataStore = await new IfcParser().parseColumnar(Uint8Array.from(source).buffer, { disableWorkerScan: true });
  useViewerStore.setState(fixtureModels({ ...fixtureModel('wall'), ifcDataStore }));

  function ExportOnMount() {
    const content = useBim().export.ifc(undefined, { schema: 'IFC4' });
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    assert.match(text, /FILE_SCHEMA\(\('IFC4'\)\)/);
    assert.match(text, /IFCWALL(?:STANDARDCASE)?\(/);
    return <span>Exported</span>;
  }

  const ui = render(<BimProvider><ExportOnMount /></BimProvider>);
  await waitFor(() => ui.textContent === 'Exported', 'first render exported STEP');
});
