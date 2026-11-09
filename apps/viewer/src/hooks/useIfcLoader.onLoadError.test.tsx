/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9497: `loadFile` hands THIS load's user-visible failure message to
 * `options.onLoadError`, so a caller (federated `addModel` →
 * `useFederationSetup`) names the right reason even when the store's global
 * `error` has since been written by another load. Both ways a load reports a
 * failure are covered: the shared error funnel (`showLoadError`) and the
 * retained kernel's refusal, which reports itself before any work.
 *
 * The parse failure is a malformed IFCX file (real synchronous JSON.parse, no
 * wasm; see `useIfcLoader.loadErrorRetry.test.tsx`).
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { chooseGeometryKernel } from '@/store/geometryKernel';
import { stepFile } from '@/test/retained-host-fixture';
import { useIfcLoader } from './useIfcLoader.js';

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  hookApi = null;
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  assert.ok(hookApi);
});

afterEach(async () => {
  chooseGeometryKernel('exact');
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

describe('loadFile reports its own failure to onLoadError (#9497)', () => {
  it('a federated parse failure passes the shown message, once', async () => {
    const messages: string[] = [];
    const file = new File(['{ this is not valid json'], 'broken.ifcx', { type: 'application/json' });
    await act(async () => hookApi!.loadFile(file, { kind: 'federated', modelId: 'broken' }, { onLoadError: (m) => messages.push(m) }));

    const shown = useViewerStore.getState().error;
    assert.match(shown ?? '', /file is invalid/);
    assert.deepEqual(messages, [shown]);
    assert.equal(useViewerStore.getState().models.has('broken'), false);
  });

  it('a retained-kernel refusal of a federated add passes its refusal message', async () => {
    chooseGeometryKernel('retained');
    const messages: string[] = [];
    await act(async () => hookApi!.loadFile(stepFile('linked.ifc'), { kind: 'federated', modelId: 'linked' }, { onLoadError: (m) => messages.push(m) }));

    const shown = useViewerStore.getState().error;
    assert.ok(shown, 'the refusal is on the error card');
    assert.deepEqual(messages, [shown]);
    assert.equal(useViewerStore.getState().models.has('linked'), false);
  });
});
