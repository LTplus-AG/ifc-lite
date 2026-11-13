/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model the share seed cannot carry is now named before the room exists.
 *
 * `buildShareSeed` drops a tabular store that is not IFCX — a `.3dm`'s source
 * holds its reader's own format, so neither `seedFromStep` nor `seedFromIfcx`
 * can read it — and the dialog used to mint a token, create the room and
 * publish a link regardless, leaving the owner a session with nothing in it
 * and no explanation. CodeRabbit on #9977 (`share-scope.ts:96`).
 *
 * The line drawn here is narrow on purpose. A model with NO store (a GLB, a
 * point cloud, a load in flight) has always produced a silent empty room and
 * still does: `buildShareSeed` must keep returning a seed for the owner path
 * (#4444), and a model removed mid-mint depends on that. Only a model that
 * has a store the seed cannot read is reported.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { render, click, cleanup } from '@/test/render.js';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import type { StartCollabOptions } from '@/store/slices/collabSlice.js';
import { act } from 'react';
import { tabularFixtureStore } from '@/test/tabular-store-fixture.js';
import { ShareDialog } from './ShareDialog.js';

/** `kind` picks the store: an IFC one, a `.3dm`-shaped tabular one, or none. */
function makeModel(id: string, name: string, idOffset: number, kind: 'ifc' | 'tabular' | 'none'): FederatedModel {
  return {
    id,
    name,
    ifcDataStore: kind === 'none' ? null
      : kind === 'tabular' ? tabularFixtureStore()
      : createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 3 }),
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 3,
    idOffset,
    maxExpressId: 10,
  };
}

const starts: StartCollabOptions[] = [];
const realStartCollab = useViewerStore.getState().startCollab;

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

const bodyText = () => document.body.textContent ?? '';
const createLinkButton = () =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Create link');

/**
 * Server mode with a stubbed relay, so "did it claim a room?" is observable:
 * in serverless mode the mint is local and leaves no trace. Same seam as
 * `ShareDialog.scope.test.tsx` uses for the #6565 preflight.
 */
function relayStub(t: TestContext) {
  window.localStorage.setItem('ifc-lite:collab:server-url', 'wss://relay.example');
  const requests: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (String(input).endsWith('/collab/release')) return Response.json({ released: true });
    return Response.json({ token: body.role === 'admin' ? 'fixture-admin' : 'fixture-invite' });
  });
  return { mints: () => requests.filter((body) => body.role === 'admin') };
}

beforeEach(() => {
  starts.length = 0;
  useViewerStore.setState({
    collabRoomId: null,
    collabRole: null,
    collabRoomModels: new Map(),
    collabLastShareToken: null,
    collabSeedFailure: null,
    startCollab: async (opts) => {
      starts.push(opts);
      useViewerStore.setState({
        collabRoomId: opts.roomId,
        collabRole: opts.role,
        collabRoomModels: new Map((opts.seed?.models ?? []).map((m, index) => [m.modelId, { slotId: `m${index}`, pathPrefix: `/m${index}` }])),
      });
    },
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem('ifc-lite:collab:server-url');
  useViewerStore.setState({ startCollab: realStartCollab, models: new Map(), activeModelId: null });
});

describe('ShareDialog: models the share seed cannot carry', () => {
  it('creates no session when every loaded model is one the seed must drop', async (t) => {
    const relay = relayStub(t);
    useViewerStore.setState({
      models: new Map([['a', makeModel('a', 'terrain.3dm', 0, 'tabular')]]),
      activeModelId: 'a',
    });
    render(<ShareDialog open onOpenChange={() => {}} />);
    await settle();
    const create = createLinkButton();
    assert.ok(create, 'the dialog offers the consent action');

    click(create);
    await settle();

    assert.equal(relay.mints().length, 0, 'a share with nothing to put in it never claims a room');
    assert.equal(starts.length, 0, 'no session is started');
    assert.equal(useViewerStore.getState().collabRoomId, null);
    assert.match(bodyText(), /No session was created\. There are no IFC records to share from: terrain\.3dm\./);
  });

  it('shares the models it can and names the one it drops', async (t) => {
    const relay = relayStub(t);
    useViewerStore.setState({
      models: new Map([
        ['a', makeModel('a', 'tower.ifc', 0, 'ifc')],
        ['b', makeModel('b', 'terrain.3dm', 1_000_000, 'tabular')],
      ]),
      activeModelId: 'a',
    });
    render(<ShareDialog open onOpenChange={() => {}} />);
    await settle();
    const create = createLinkButton();
    assert.ok(create);

    click(create);
    await settle();

    assert.equal(relay.mints().length, 1, 'the share still happens for the model that can be seeded');
    assert.deepEqual(starts[0]?.seed?.models.map((m) => m.modelId), ['a'], 'only the IFC model goes into the room');
    assert.match(bodyText(), /Left out of the shared session, no IFC records to share from: terrain\.3dm\./);
  });

  it('leaves a store-less workspace exactly as it was: a session, and nothing claimed about records', async (t) => {
    const relay = relayStub(t);
    useViewerStore.setState({
      models: new Map([['a', makeModel('a', 'scan.glb', 0, 'none')]]),
      activeModelId: 'a',
    });
    render(<ShareDialog open onOpenChange={() => {}} />);
    await settle();
    const create = createLinkButton();
    assert.ok(create);

    click(create);
    await settle();

    assert.equal(relay.mints().length, 1, 'a GLB-only workspace still creates its room, as on main');
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0]?.seed?.models, [], 'the owner path takes an empty seed');
    assert.doesNotMatch(bodyText(), /IFC records to share from/, 'nothing had a store to drop, so nothing is named');
  });
});
