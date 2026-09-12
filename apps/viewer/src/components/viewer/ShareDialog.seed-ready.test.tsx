/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4446 — the Share dialog must not hand out an invite while the initial
 * seed is still going into the room.
 *
 * `collabRoomId` is set synchronously at the top of `startCollab` and the
 * provider reports `connected` before a single entity is in the doc; the
 * dialog used to mint the link off the room id alone. It now keys off
 * `collabSeedPhase`: a progress row stands in for the link until the seed
 * settles, and a settled-but-incomplete seed shows the link WITH the
 * incomplete-transfer alert, never as a plain success.
 *
 * Renders the real dialog over the real store as the room's admin; no server
 * is configured, so minting is the local-only fallback and touches no network.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { ShareDialog } from './ShareDialog.js';

function makeModel(): FederatedModel {
  return {
    id: 'model-1',
    name: 'haus.ifc',
    ifcDataStore: { schemaVersion: 'IFC4' } as unknown as FederatedModel['ifcDataStore'],
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 3,
    idOffset: 0,
    maxExpressId: 0,
  };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderDialog(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ShareDialog open onOpenChange={() => {}} />);
  });
  mounted.push({ root, container });
}

/** Let the mint effect's awaited (local, network-free) token resolve. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Radix renders the dialog into a portal, so read the whole document. */
function linkField(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('#share-link');
  assert.ok(el, 'the dialog rendered its link field');
  return el;
}
function copyButton(): HTMLButtonElement {
  const el = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Copy');
  assert.ok(el, 'the dialog rendered its Copy button');
  return el;
}
function statusText(): string {
  return Array.from(document.querySelectorAll('[role="status"]'))
    .map((el) => el.textContent ?? '')
    .join(' ');
}
function alertText(): string {
  return Array.from(document.querySelectorAll('[role="alert"]'))
    .map((el) => el.textContent ?? '')
    .join(' ');
}

beforeEach(() => {
  useViewerStore.setState({
    models: new Map([['model-1', makeModel()]]),
    activeModelId: 'model-1',
    // The owner, mid-join: room id public, admin bearer held, seed in flight.
    collabRoomId: 'room-1',
    collabRole: 'admin',
    collabSelfToken: 'admin-token',
    collabLastShareToken: null,
    collabSeedFailure: null,
    collabSeedPhase: 'geometry',
    collabSeedProgress: { uploaded: 120, total: 272, modelIndex: 0, modelCount: 1 },
  });
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  useViewerStore.setState({
    collabRoomId: null,
    collabRole: null,
    collabSelfToken: null,
    collabLastShareToken: null,
    collabSeedFailure: null,
    collabSeedPhase: 'none',
    collabSeedProgress: null,
  });
});

describe('ShareDialog: invite waits for the initial seed (#4446)', () => {
  it('shows upload progress instead of a link while geometry is still going into the room', async () => {
    renderDialog();
    await settle();
    assert.match(statusText(), /Uploading geometry 120\/272/);
    assert.doesNotMatch(linkField().value, /room=/, 'no invite URL while the seed is in flight');
    assert.equal(copyButton().disabled, true, 'Copy stays disabled');
  });

  it('says it is still connecting before the room has synced', async () => {
    useViewerStore.setState({ collabSeedPhase: 'syncing', collabSeedProgress: null });
    renderDialog();
    await settle();
    assert.match(statusText(), /Connecting to the room/);
    assert.equal(copyButton().disabled, true);
  });

  it('still withholds the link while the relay has not confirmed the upload (#4446)', async () => {
    useViewerStore.setState({ collabSeedPhase: 'confirming', collabSeedProgress: null });
    renderDialog();
    await settle();
    assert.match(statusText(), /Confirming the upload with the room server/);
    assert.doesNotMatch(linkField().value, /room=/, 'everything is written locally, but the relay has not said it holds it');
    assert.equal(copyButton().disabled, true);
  });

  it('mints the invite and enables Copy the moment the seed reports ready', async () => {
    renderDialog();
    await settle();
    assert.equal(copyButton().disabled, true, 'precondition: still uploading');

    act(() => {
      useViewerStore.setState({ collabSeedPhase: 'ready', collabSeedProgress: null });
    });
    await settle();

    assert.match(linkField().value, /room=room-1/, 'the invite names the room');
    assert.equal(copyButton().disabled, false, 'Copy is enabled once the room holds the model');
    assert.equal(statusText().trim(), '', 'the progress row is gone');
    assert.equal(alertText().trim(), '', 'a clean seed shows no alert');
    assert.ok(useViewerStore.getState().collabLastShareToken, 'the minted token is recorded for revocation');
  });

  it('a seed that lost geometry hands out the link only alongside the incomplete-transfer alert', async () => {
    renderDialog();
    await settle();
    act(() => {
      useViewerStore.setState({
        collabSeedPhase: 'partial',
        collabSeedProgress: null,
        collabSeedFailure: 'Shared, but 3 of 272 geometry uploads failed. People joining this link will be missing some elements.',
      });
    });
    await settle();
    assert.match(linkField().value, /room=room-1/, 'the room exists and can still be shared');
    assert.equal(copyButton().disabled, false);
    assert.match(alertText(), /missing some elements/, 'but never as a plain success');
  });

  it('a joiner is unaffected: forwards the invite it holds without waiting on any seed', async () => {
    // Recipients never seed; their phase stays 'none'.
    useViewerStore.setState({
      collabRole: 'viewer',
      collabSelfToken: null,
      collabLastShareToken: 'token-1',
      collabSeedPhase: 'none',
      collabSeedProgress: null,
    });
    renderDialog();
    await settle();
    assert.match(linkField().value, /room=room-1/);
    assert.equal(copyButton().disabled, false);
    assert.equal(statusText().trim(), '');
  });
});
