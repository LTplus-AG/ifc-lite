/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5851 review, BLOCKER — confirmed repro: after a primary model A loads,
 * `lastLoadRetry` is left over from A's own successful `loadFile` call
 * (nothing cleared it on success). A federated failure (`loadFederatedIfcx`
 * / `addIfcxOverlays`) called `showLoadError` without ever touching
 * `lastLoadRetry`, so the card's Retry button silently replayed A's load
 * instead of the failed federated add.
 *
 * Root-cause fix: `showLoadError` takes `retry` as a REQUIRED argument, so
 * a call site cannot show an error without deciding what Retry does, and
 * `setError(null)` now clears
 * `lastLoadRetry` whenever `error` is cleared — so a stale retry from an
 * unrelated success can never survive to sit next to the next error.
 *
 * This test drives the real hook (not a source grep): seeds a "stale
 * primary retry" the way an old bug would have left one behind, drives a
 * real federated failure through `loadFederatedIfcx`, and asserts the
 * published retry is the FEDERATED one — calling it never reaches the
 * primary `loadFile` stub, and it reproduces the federated failure again.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useIfcFederation } from './useIfcFederation.js';

/** Detected as IFCX by its leading `{` (see `packages/ifcx/detectFormat`), but not valid JSON — a real, deterministic composition failure with no wasm engine involved. */
function badIfcxFile(name: string): File {
  return new File(['{ this is not valid json'], name, { type: 'application/json' });
}

let primaryLoadCalls = 0;
const loadFileStub = async (): Promise<void> => {
  primaryLoadCalls += 1;
  throw new Error('primary loadFile must never be invoked by a federated retry');
};

let hookApi: ReturnType<typeof useIfcFederation> | null = null;
function Probe(): null {
  hookApi = useIfcFederation(loadFileStub);
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  primaryLoadCalls = 0;
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

describe('federated load-error retry (#5851 review, BLOCKER)', () => {
  it('a federated failure overwrites a stale retry left by a prior successful primary load, and Retry never reaches loadFile', async () => {
    // Seed the exact stale state a pre-fix successful `loadFile("A", ...)`
    // would have left behind: `lastLoadRetry` pointing at re-running A.
    let staleRetryCalls = 0;
    act(() => useViewerStore.setState({
      error: null,
      lastLoadRetry: () => { staleRetryCalls += 1; void loadFileStub(); },
    }));

    await act(async () => hookApi!.loadFederatedIfcx([badIfcxFile('overlay.ifcx')]));

    assert.match(useViewerStore.getState().error ?? '', /Federated IFCX loading failed/);
    const retry = useViewerStore.getState().lastLoadRetry;
    assert.equal(typeof retry, 'function', 'the federated failure published its own retry');

    act(() => useViewerStore.setState({ error: null }));
    act(() => { retry!(); });

    await waitFor(() => useViewerStore.getState().error !== null, 'the federated retry reproduces the federated failure');
    assert.match(useViewerStore.getState().error ?? '', /Federated IFCX loading failed/, 'retry replayed the FEDERATED add, not something else');
    assert.equal(staleRetryCalls, 0, 'the stale primary-load retry was overwritten, never called');
    assert.equal(primaryLoadCalls, 0, 'Retry never silently reloaded the primary model');
  });

  it('addIfcxOverlays with no base model publishes a retry that re-runs the SAME overlay add, not loadFile', async () => {
    let staleRetryCalls = 0;
    act(() => useViewerStore.setState({
      error: null,
      ifcDataStore: null,
      lastLoadRetry: () => { staleRetryCalls += 1; },
    }));

    await act(async () => hookApi!.addIfcxOverlays([badIfcxFile('overlay.ifcx')]));

    assert.match(useViewerStore.getState().error ?? '', /no IFCX model loaded/);
    const retry = useViewerStore.getState().lastLoadRetry;
    assert.equal(typeof retry, 'function');

    act(() => useViewerStore.setState({ error: null }));
    act(() => { retry!(); });

    await waitFor(() => useViewerStore.getState().error !== null, 'retrying addIfcxOverlays reproduces its own failure');
    assert.match(useViewerStore.getState().error ?? '', /no IFCX model loaded/);
    assert.equal(staleRetryCalls, 0);
    assert.equal(primaryLoadCalls, 0);
  });
});
