/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IDSPanel`'s unmount cleanup — the one release site of the per-row focus
 * (#2867) that no test drove. Deleting the cleanup outright left every suite
 * green (verified by mutation, review of #2867), which is exactly the state
 * `ClashPanel.focus-teardown.test.tsx` exists to prevent on the clash side:
 * leaving the panel with an isolate- or ghost-mode row focus would strand the
 * model isolated on, or faded around, an element whose panel is gone.
 *
 * Both channels the row focus writes are checked: the shared VISIBILITY
 * channel and the PAINT channel (`pendingColorUpdates`), whose focus tint
 * `ClashPanel` has always handed back on unmount and `IDSPanel` did not.
 *
 * The release is ownership-scoped, so the third case here is the one that
 * makes the other two mean something: a presentation belonging to somebody
 * else must survive the panel closing.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { IDSPanel } from './IDSPanel.js';
import { IDS_FOCUS_COLOR } from '@/hooks/ids/idsColorSystem.js';

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });

let root: Root | null = null;
let container: HTMLElement | null = null;

/** Mount the panel with a row-focus presentation already installed into
 *  `channel`, and return the unmount. */
async function mountWithRowFocus(
  channel: 'isolate' | 'ghost',
  ids: number[],
): Promise<() => Promise<void>> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<IDSPanel />);
  });
  await act(async () => {
    useViewerStore.setState({
      isolatedEntities: channel === 'isolate' ? new Set(ids) : null,
      ghostExceptEntities: channel === 'ghost' ? new Set(ids) : null,
      idsFocusVisibilityOwned: { channel, ids: new Set(ids) },
      pendingColorUpdates: new Map<number, [number, number, number, number]>(
        ids.map((id) => [id, IDS_FOCUS_COLOR]),
      ),
      lensAppliedColors: null,
    });
  });
  const closing = root;
  root = null;
  return async () => { await act(async () => closing!.unmount()); };
}

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
  // One Zustand store is shared across every node:test file — put back what
  // this suite seeded.
  useViewerStore.setState({
    isolatedEntities: null,
    ghostExceptEntities: null,
    idsFocusVisibilityOwned: null,
    pendingColorUpdates: null,
    lensAppliedColors: null,
  });
});

describe('IDSPanel unmount ends the IDS row-focus presentation (#2867)', () => {
  it('releases a row ISOLATION rather than leaving the model isolated on a closed panel', async () => {
    const unmount = await mountWithRowFocus('isolate', [1]);
    await unmount();

    const s = useViewerStore.getState();
    assert.equal(s.isolatedEntities, null,
      'the panel is gone; an isolation it installed left standing hides the model with nothing on screen to explain it');
    assert.equal(s.idsFocusVisibilityOwned, null,
      'and the claim goes with it — a record that outlives its presentation re-matches later');
  });

  it('releases a row GHOST, and hands the focus tint back with it', async () => {
    const unmount = await mountWithRowFocus('ghost', [1]);
    await unmount();

    const s = useViewerStore.getState();
    assert.equal(s.ghostExceptEntities, null, 'the fade around the focused element ends with the panel');
    assert.equal(s.idsFocusVisibilityOwned, null);
    assert.notDeepEqual(s.pendingColorUpdates?.get(1), IDS_FOCUS_COLOR,
      'the focus marker is painted through the albedo channel — clearing the record alone leaves it on the model');
  });

  it('leaves a presentation IDS does not own exactly as the user left it', async () => {
    const unmount = await mountWithRowFocus('ghost', [1]);
    // Another feature (the spaces X-ray, LayerDiffView, clash) takes the same
    // channel over with different content, so the IDS record no longer matches.
    await act(async () => {
      useViewerStore.setState({ ghostExceptEntities: new Set([1, 9]) });
    });
    await unmount();

    const s = useViewerStore.getState();
    assert.deepEqual(s.ghostExceptEntities && [...s.ghostExceptEntities].sort((a, b) => a - b), [1, 9],
      "IDS installed {1}, the channel shows {1, 9} — that is somebody else's presentation (#2654)");
  });
});
