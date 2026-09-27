/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5600: failed collaboration actions were only logged. `revokeCollabLink`
 * and `kickPeer` resolve `false` on failure and RoomPanel ignored it, so an
 * admin could believe a link was revoked or a peer removed when it was not;
 * both copy buttons (RoomPanel, ShareDialog) swallowed a clipboard failure.
 * Each failure must now raise a translated `toast.error`.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { PresenceState } from '@ifc-lite/collab';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import { cleanup, render } from '@/test/render.js';
import { resolve } from '@/i18n/registry.js';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { toast } from '@/components/ui/toast';
import { RoomPanel } from './RoomPanel.js';
import { ShareDialog } from './ShareDialog.js';

const PEER: PresenceState & { clientId: number } = {
  user: { id: 'peer-1', name: 'Peer One', color: '#f00' },
  selection: [],
  status: 'active',
  lastUpdate: 0,
  role: 'editor',
  clientId: 7,
};

const initial = useViewerStore.getState();
let errorMock: ReturnType<typeof mock.method>;
let warnMock: ReturnType<typeof mock.method>;

function makeModel(): FederatedModel {
  return {
    id: 'model-1',
    name: 'haus.ifc',
    ifcDataStore: createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 3 }),
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

function button(root: ParentNode, match: (b: HTMLButtonElement) => boolean): HTMLButtonElement {
  const el = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(match);
  assert.ok(el, 'expected button is rendered');
  return el;
}

async function click(el: HTMLButtonElement): Promise<void> {
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function toastMessages(): string[] {
  return errorMock.mock.calls.map((c) => String(c.arguments[0]));
}

beforeEach(() => {
  errorMock = mock.method(toast, 'error', () => {});
  warnMock = mock.method(console, 'warn', () => {});
  // happy-dom has no clipboard; make the blocked-clipboard case explicit.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error('clipboard blocked')) },
  });
  useViewerStore.setState({
    collabRoomId: 'room-1',
    collabStatus: 'connected',
    collabRole: 'admin',
    collabSelfToken: 'admin-token',
    collabLastShareToken: 'share-token',
    collabPeers: [PEER],
    collabSeedPhase: 'ready',
    collabSeedProgress: null,
    collabSeedFailure: null,
    revokeCollabLink: async () => false,
    kickPeer: async () => false,
  });
});

afterEach(() => {
  cleanup();
  errorMock.mock.restore();
  warnMock.mock.restore();
  Reflect.deleteProperty(navigator, 'clipboard');
  useViewerStore.setState({
    models: new Map(),
    activeModelId: null,
    collabRoomId: null,
    collabStatus: 'disconnected',
    collabRole: null,
    collabSelfToken: null,
    collabLastShareToken: null,
    collabPeers: [],
    collabSeedPhase: 'none',
    collabSeedFailure: null,
    revokeCollabLink: initial.revokeCollabLink,
    kickPeer: initial.kickPeer,
  });
});

describe('RoomPanel collab action failures (#5600)', () => {
  it('toasts when revoking the share link fails, and does not claim "Revoked"', async () => {
    const container = render(<RoomPanel onClose={() => {}} />);
    await click(button(container, (b) => b.textContent?.trim() === resolve('zonesPanel.roomPanel.revokeLinkLabel')));
    assert.deepEqual(toastMessages(), [resolve('zonesPanel.roomPanel.revokeLinkFailed')]);
    assert.ok(!container.textContent?.includes(resolve('zonesPanel.roomPanel.revokedLabel')));
  });

  it('toasts when removing a peer fails', async () => {
    const container = render(<RoomPanel onClose={() => {}} />);
    const label = resolve('zonesPanel.roomPanel.removePeerAriaLabel', { name: 'Peer One' });
    await click(button(container, (b) => b.getAttribute('aria-label') === label));
    assert.deepEqual(toastMessages(), [resolve('zonesPanel.roomPanel.removePeerFailed', { name: 'Peer One' })]);
  });

  it('toasts when the invite link cannot be copied', async () => {
    const container = render(<RoomPanel onClose={() => {}} />);
    await click(button(container, (b) => b.textContent?.trim() === resolve('zonesPanel.roomPanel.copyInviteLinkLabel')));
    assert.deepEqual(toastMessages(), [resolve('zonesPanel.roomPanel.copyLinkFailed')]);
  });
});

describe('ShareDialog copy failure (#5600)', () => {
  it('toasts when the link cannot be copied', async () => {
    useViewerStore.setState({ models: new Map([['model-1', makeModel()]]), activeModelId: 'model-1' });
    render(<ShareDialog open onOpenChange={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const copy = button(document, (b) => b.textContent?.trim() === resolve('shareDialog.copy'));
    assert.equal(copy.disabled, false, 'precondition: a link was minted');
    await click(copy);
    assert.deepEqual(toastMessages(), [resolve('shareDialog.copyFailed')]);
  });
});
