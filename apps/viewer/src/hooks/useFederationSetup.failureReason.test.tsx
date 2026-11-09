/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9497: a federation-setup slot that does not load names ITS load's reason.
 * The reason used to be read from the store's global `error` after `addModel`
 * returned, which another load may already have cleared or overwritten, and a
 * retained-kernel refusal (reported outside `showLoadError`) must still come
 * through. Drives the real hook stack: useFederationSetup → addModel → loadFile.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { chooseGeometryKernel } from '@/store/geometryKernel';
import { render, cleanup } from '@/test/render.js';
import { stepFile } from '@/test/retained-host-fixture';
import type { FederationSetupFile, FederationSetupSlotMatch } from '@/lib/federation/federationSetupFile.js';
import { useFederationSetup } from './useFederationSetup.js';

let setup: ReturnType<typeof useFederationSetup>;
function Probe() { setup = useFederationSetup(); return null; }

function oneSlot(file: File): { saved: FederationSetupFile; matches: FederationSetupSlotMatch[] } {
  const slot = { name: file.name, fileSize: file.size, fingerprintHex: null, visible: true, collapsed: false, anchor: false, tagIds: [] };
  return {
    saved: { formatVersion: 1, tags: [], slots: [slot] },
    matches: [{ slot, slotIndex: 0, file, confidence: 'name-size' }],
  };
}

beforeEach(() => {
  useViewerStore.getState().clearAllModels();
  useViewerStore.getState().resetViewerState();
  render(<Probe />);
});
afterEach(() => {
  cleanup();
  chooseGeometryKernel('exact');
  useViewerStore.getState().clearAllModels();
});

describe('useFederationSetup failed-slot reason (#9497)', () => {
  it("keeps the slot's own load error after another load cleared the error card", async () => {
    const { saved, matches } = oneSlot(new File(['{ this is not valid json'], 'broken.ifcx', { type: 'application/json' }));
    let shown: string | null = null;
    // Another load starting (setError(null)) right after this one reported.
    const unsubscribe = useViewerStore.subscribe((state) => {
      if (state.error && shown === null) { shown = state.error; state.setError(null); }
    });
    let result: Awaited<ReturnType<typeof setup.applyFederationSetup>>;
    try { result = await act(async () => setup.applyFederationSetup(saved, matches)); } finally { unsubscribe(); }

    assert.match(shown ?? '', /file is invalid/);
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.failedSlots, [{ name: 'broken.ifcx', reason: shown }]);
  });

  it('names a retained-kernel refusal as the reason', async () => {
    chooseGeometryKernel('retained');
    const { saved, matches } = oneSlot(stepFile('linked.ifc'));
    const result = await act(async () => setup.applyFederationSetup(saved, matches));

    const shown = useViewerStore.getState().error;
    assert.ok(shown, 'the refusal is on the error card');
    assert.deepEqual(result.failedSlots, [{ name: 'linked.ifc', reason: shown }]);
  });
});
