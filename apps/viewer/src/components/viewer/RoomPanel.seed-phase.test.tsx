/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4446 — the room panel must not call a room "Live" while the owner's
 * initial seed is still going into it, and must not hand out its own copy
 * link either (it mints one exactly like the Share dialog does).
 *
 * `collabStatus` is the PROVIDER's word ('connected' the moment the socket
 * handshakes); the panel reads `collabSeedPhase` over it. Renders the real
 * panel over the real store.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store/index.js';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { RoomPanel } from './RoomPanel.js';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderPanel(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <TooltipProvider>
        <RoomPanel onClose={() => {}} />
      </TooltipProvider>,
    );
  });
  mounted.push({ root, container });
}

function button(label: RegExp): HTMLButtonElement {
  const el = Array.from(document.querySelectorAll('button')).find((b) => label.test(b.textContent?.trim() ?? ''));
  assert.ok(el, `a button matching ${label} rendered`);
  return el;
}
function statusText(): string {
  return Array.from(document.querySelectorAll('[role="status"]'))
    .map((el) => el.textContent ?? '')
    .join(' ');
}

beforeEach(() => {
  useViewerStore.setState({
    // The owner, mid-seed: the socket is up ('connected'), the room is not.
    collabRoomId: 'room-1',
    collabRole: 'admin',
    collabStatus: 'connected',
    collabSelfToken: 'admin-token',
    collabPeers: [],
    collabSeedPhase: 'geometry',
    collabSeedProgress: { uploaded: 120, total: 272 },
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
    collabStatus: 'disconnected',
    collabSelfToken: null,
    collabSeedPhase: 'none',
    collabSeedProgress: null,
  });
});

describe('RoomPanel: a connected room is not "Live" until the seed is in (#4446)', () => {
  it('says the model is uploading, with progress, and withholds the copy link', () => {
    renderPanel();
    assert.match(document.body.textContent ?? '', /Uploading model/);
    assert.doesNotMatch(document.body.textContent ?? '', /Live room/, "'connected' alone does not make the room Live");
    assert.match(statusText(), /uploading geometry 120\/272/);
    assert.equal(button(/^Copy invite link$/).disabled, true, 'no invite until the model is in the room');
    assert.match(button(/^Leave/).textContent ?? '', /abandons upload/, 'Leave says what it would abandon');
  });

  it('flips to Live, with the copy link and a plain Leave, the moment the seed reports ready', () => {
    renderPanel();
    act(() => {
      useViewerStore.setState({ collabSeedPhase: 'ready', collabSeedProgress: null });
    });
    assert.match(document.body.textContent ?? '', /Live room/);
    assert.equal(statusText().trim(), '', 'the progress row is gone');
    assert.equal(button(/^Copy invite link$/).disabled, false);
    assert.equal(button(/^Leave/).textContent?.trim(), 'Leave room');
  });

  it('a recipient never seeds, so its panel is Live as soon as it is connected', () => {
    useViewerStore.setState({ collabRole: 'viewer', collabSelfToken: null, collabSeedPhase: 'none', collabSeedProgress: null });
    renderPanel();
    assert.match(document.body.textContent ?? '', /Live room/);
    assert.equal(button(/^Copy invite link$/).disabled, false);
  });
});
