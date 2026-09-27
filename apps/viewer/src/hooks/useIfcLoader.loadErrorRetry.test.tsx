/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5851 — the load-error card's Retry must re-run the load that failed,
 * same File and target, through the canonical `loadFile`. `loadFile` sets
 * `lastLoadRetry` to exactly that closure before the load can fail (so a
 * failure anywhere in the function leaves a working Retry behind it); this
 * drives a real failure and calls the closure back, the same way the card's
 * Retry button does (`ViewportLoadErrorCard.test.tsx` covers the button
 * itself against a stubbed closure).
 *
 * The failure fixture is a malformed IFCX file: `parseIfcx`'s JSON.parse is
 * real, synchronous JS with no wasm engine involved (see
 * `useIfcLoader.ifcxStaleGuard.test.tsx`'s header), so this stays fast and
 * needs no built `@ifc-lite/wasm`.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useIfcLoader } from './useIfcLoader.js';

function badIfcxFile(name: string): File {
  return new File(['{ this is not valid json'], name, { type: 'application/json' });
}

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
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

describe('loadFile Retry closure (#5851)', () => {
  it('a failed load sets error and a lastLoadRetry that re-runs loadFile with the same File', async () => {
    const file = badIfcxFile('broken.ifcx');
    await act(async () => hookApi!.loadFile(file, { kind: 'primary' }));

    assert.match(useViewerStore.getState().error ?? '', /IFCX parsing failed/);
    const retry = useViewerStore.getState().lastLoadRetry;
    assert.equal(typeof retry, 'function', 'a retry closure is published for the card to call');

    // Clear the observable effects, then invoke the SAME closure the card's
    // Retry button calls (`useLoadErrorCard.ts`) and confirm it re-enters
    // loadFile with the identical file — not a new/different source.
    act(() => useViewerStore.setState({ error: null, loadingFileName: null }));
    act(() => { retry!(); });
    // loadFile's very first observable write is setLoadingFileName(file.name);
    // seeing "broken.ifcx" again proves THIS retry replayed THIS file.
    await waitFor(() => useViewerStore.getState().loadingFileName === 'broken.ifcx', 'retry re-enters loadFile with the same file');
    await waitFor(() => useViewerStore.getState().error !== null, 'the same bad file fails the same way again');
    assert.match(useViewerStore.getState().error ?? '', /IFCX parsing failed/);
  });
});
