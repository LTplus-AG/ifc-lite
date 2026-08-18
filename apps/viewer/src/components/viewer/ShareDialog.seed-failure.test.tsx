/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A share whose geometry never reached the room must not be handed over as a
 * plain success. The dialog used to show only the link, so the one failure
 * mode that makes a room useless to everyone who opens it (structure synced,
 * geometry missing) looked exactly like a healthy share.
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
    name: 'tower.ifc',
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

/** Radix renders the dialog into a portal, so read the whole document. */
function alertText(): string {
  return Array.from(document.querySelectorAll('[role="alert"]'))
    .map((el) => el.textContent ?? '')
    .join(' ');
}

beforeEach(() => {
  useViewerStore.setState({
    models: new Map([['model-1', makeModel()]]),
    activeModelId: 'model-1',
    // A joined room with a non-admin role: the dialog reuses the invite it
    // holds instead of minting, so opening it touches no network.
    collabRoomId: 'room-1',
    collabRole: 'viewer',
    collabLastShareToken: 'token-1',
    collabSeedFailure: null,
  });
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  useViewerStore.setState({ collabSeedFailure: null });
});

describe('ShareDialog: a seed that lost the model geometry', () => {
  it('says nothing when the seed was fine', () => {
    renderDialog();
    // Anchor on the link field: without it "no alert" would also be true of a
    // dialog that rendered nothing at all.
    assert.ok(document.querySelector('#share-link'), 'the dialog rendered its link field');
    assert.equal(alertText().trim(), '', 'a healthy share shows no alert');
  });

  it('surfaces the failure instead of presenting the link as a success', () => {
    useViewerStore.setState({
      collabSeedFailure: 'Geometry upload failed: the server is refusing uploads.',
    });
    renderDialog();
    assert.match(alertText(), /Geometry upload failed/);
  });
});
