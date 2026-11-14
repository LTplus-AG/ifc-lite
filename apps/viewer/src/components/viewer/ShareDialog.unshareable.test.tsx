/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model the share seed cannot carry is now named, and a share with nothing
 * to put in a room creates none.
 *
 * `buildShareSeed` drops a tabular store that is not IFCX — a `.3dm`'s source
 * holds its reader's own format, so neither `seedFromStep` nor `seedFromIfcx`
 * can read it — and the dialog used to mint a token, create the room and
 * publish a link regardless, leaving the owner a session with nothing in it
 * and no explanation. CodeRabbit on #9977 (`share-scope.ts:96`).
 *
 * The line is drawn on the MODEL, not on the seed's length. A model with NO
 * store (a GLB, a point cloud, a load in flight) has always produced a silent
 * empty room and still does: `buildShareSeed` must keep returning a seed for
 * the owner path (#4444), and a model removed mid-mint depends on that. Only
 * a model that has a store the seed cannot read is reported.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render.js';
import { settle } from '@/test/settle.js';
import { deferred } from '@/test/race.js';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import type { StartCollabOptions } from '@/store/slices/collabSlice.js';
import { tabularFixtureStore } from '@/test/tabular-store-fixture.js';
import { fixtureModels } from '@/test/store-fixture.js';
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

const bodyText = () => document.body.textContent ?? '';
const createLinkButton = () =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Create link');
const scopeRadios = (): HTMLElement[] => {
  const group = document.querySelector('[role="radiogroup"][aria-label="Share scope"]');
  return group ? Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]')) : [];
};

/**
 * Server mode with a stubbed relay, so "did it claim a room?" is observable:
 * in serverless mode the mint is local and leaves no trace. Same seam as
 * `ShareDialog.scope.test.tsx` uses for the #6565 preflight.
 */
function relayStub(t: TestContext, adminGate?: Promise<void>) {
  window.localStorage.setItem('ifc-lite:collab:server-url', 'wss://relay.example');
  const requests: Array<Record<string, unknown>> = [];
  let releases = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (String(input).endsWith('/collab/release')) { releases++; return Response.json({ released: true }); }
    if (body.role === 'admin') await adminGate;
    return Response.json({ token: body.role === 'admin' ? 'fixture-admin' : 'fixture-invite' });
  });
  return { mints: () => requests.filter((body) => body.role === 'admin'), releases: () => releases };
}

/**
 * Open the dialog over `models` and press "Create link". Settles on event-loop
 * turns rather than a fixed sleep, because every assertion below it is
 * negative ("no room was claimed") and a wall-clock budget would let those
 * pass vacuously under load (`@/test/settle.ts`).
 */
async function createLinkOver(t: TestContext, ...models: FederatedModel[]) {
  const relay = relayStub(t);
  useViewerStore.setState(fixtureModels(...models));
  render(<ShareDialog open onOpenChange={() => {}} />);
  await act(() => settle('the share dialog did not settle before the consent action'));
  const create = createLinkButton();
  assert.ok(create, 'the dialog offers the consent action');
  // What the owner reads BEFORE committing anything.
  const beforeConsent = bodyText();
  click(create);
  await act(() => settle('room creation did not settle'));
  return { relay, beforeConsent };
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
  it('offers no Create link when every loaded model is one the seed must drop', async (t) => {
    const relay = relayStub(t);
    useViewerStore.setState(fixtureModels(makeModel('a', 'terrain.3dm', 0, 'tabular')));
    render(<ShareDialog open onOpenChange={() => {}} />);
    await act(() => settle('the share dialog did not settle'));

    assert.match(bodyText(), /Nothing here can be shared, no IFC records to share from: terrain\.3dm\./,
      'the owner is told before pressing anything');
    const create = createLinkButton();
    assert.equal(create?.disabled, true, 'Create link is disabled');
    const reason = document.getElementById(create?.getAttribute('aria-describedby') ?? '');
    assert.match(reason?.textContent ?? '', /Nothing here can be shared/, 'and described by the sentence that says why');
    assert.doesNotMatch(bodyText(), /Creating the link uploads/, 'no upload notice for a link that will not be made');
    assert.equal(relay.mints().length, 0);
  });

  it('claims no room when the models change between consent and mint', async (t) => {
    // The mint guard, not the button. The guard reads the store, not the
    // dialog's render, so it is driven here by swapping the models in the
    // same act as the click; in the app the disabled button is what stops
    // this, and the guard is the backstop behind it.
    const relay = relayStub(t);
    useViewerStore.setState(fixtureModels(makeModel('a', 'tower.ifc', 0, 'ifc')));
    render(<ShareDialog open onOpenChange={() => {}} />);
    await act(() => settle('the share dialog did not settle'));
    const create = createLinkButton();
    assert.equal(create?.disabled, false, 'an IFC can be shared, so Create link is offered');

    act(() => {
      create!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      useViewerStore.setState(fixtureModels(makeModel('b', 'terrain.3dm', 0, 'tabular')));
    });
    await act(() => settle('room creation did not settle'));
    assert.equal(relay.mints().length, 0, 'a share with nothing to put in it never claims a room');
    assert.equal(starts.length, 0, 'no session is started');
    assert.equal(useViewerStore.getState().collabRoomId, null);

    // The refused attempt is not left holding the dialog: once an IFC is back,
    // Create link is offered again and a press makes the room.
    await act(async () => {
      useViewerStore.setState(fixtureModels(makeModel('c', 'tower.ifc', 0, 'ifc')));
      await settle('the share dialog did not settle after the IFC came back');
    });
    assert.equal(relay.mints().length, 0, 'the returning IFC is not uploaded without a new press');
    const again = createLinkButton();
    assert.equal(again?.disabled, false, 'Create link is offered again');
    click(again!);
    await act(() => settle('room creation did not settle'));
    assert.equal(relay.mints().length, 1, 'the second press claims a room');
    assert.equal(starts.length, 1);
  });

  it('creates no room when the models change while the admin token is minting', async (t) => {
    // The shareability check passes at the click; the IFC is swapped for a
    // lone .3dm while the mint is pending. The seed is built after the mint,
    // so the decision must be taken on it, not on the earlier check.
    const mintGate = deferred();
    const relay = relayStub(t, mintGate.promise);
    useViewerStore.setState(fixtureModels(makeModel('a', 'tower.ifc', 0, 'ifc')));
    render(<ShareDialog open onOpenChange={() => {}} />);
    await act(() => settle('the share dialog did not settle'));
    click(createLinkButton()!);
    await act(() => settle('the mint did not start', { ready: () => relay.mints().length === 1 }));

    await act(async () => {
      useViewerStore.setState(fixtureModels(makeModel('b', 'terrain.3dm', 0, 'tabular')));
      mintGate.resolve();
      await settle('room creation did not settle after the mint returned');
    });
    assert.equal(starts.length, 0, 'no session is started on a seed with nothing in it');
    assert.equal(useViewerStore.getState().collabRoomId, null);
    assert.equal(relay.releases(), 1, 'the claimed room is handed back');
    assert.equal(relay.mints().length, 1, 'the refusal does not claim another room');

    // Consent and the slot were handed back: a shareable model brings Create
    // link back, and only a new press claims a room.
    await act(async () => {
      useViewerStore.setState(fixtureModels(makeModel('c', 'tower.ifc', 0, 'ifc')));
      await settle('the share dialog did not settle after the IFC came back');
    });
    assert.equal(starts.length, 0, 'the returning IFC is not uploaded without a new press');
    const again = createLinkButton();
    assert.equal(again?.disabled, false, 'Create link is offered again');
    click(again!);
    await act(() => settle('room creation did not settle'));
    assert.equal(starts.length, 1, 'the second press creates the room');
    assert.equal(relay.mints().length, 2);
  });

  it('shares the models it can and names the one it drops', async (t) => {
    const { relay, beforeConsent } = await createLinkOver(
      t, makeModel('a', 'tower.ifc', 0, 'ifc'), makeModel('b', 'terrain.3dm', 1_000_000, 'tabular'),
    );

    assert.match(beforeConsent, /Left out of the shared session, no IFC records to share from: terrain\.3dm\./);
    assert.equal(relay.mints().length, 1, 'the share still happens for the model that can be seeded');
    assert.deepEqual(starts[0]?.seed?.models.map((m) => m.modelId), ['a'], 'only the IFC model goes into the room');
  });

  it('says the same thing the mint does when the scope is "Active model only"', async (t) => {
    // The line the owner reads and the decision the mint makes were asked at
    // two different scopes: the notice took its seedable count over 'all'
    // while the mint asked the SELECTED scope. Active is a `.3dm`, a readable
    // IFC is loaded beside it, so 'all' sees one seedable model and 'active'
    // sees none. The dialog promised a partial share; the hook created no
    // room and said nothing more.
    const relay = relayStub(t);
    useViewerStore.setState(fixtureModels(
      makeModel('a', 'terrain.3dm', 0, 'tabular'), makeModel('b', 'tower.ifc', 1_000_000, 'ifc'),
    ));
    render(<ShareDialog open onOpenChange={() => {}} />);
    await act(() => settle('the share dialog did not settle before the scope choice'));

    click(scopeRadios()[0]!);
    await act(() => settle('picking the active-only scope did not settle'));
    assert.match(bodyText(), /Nothing here can be shared, no IFC records to share from: terrain\.3dm\./,
      'with only the .3dm in scope the owner is told nothing can be shared');
    // And the scope field's caption is not promising the opposite directly
    // above it: "Only x is shared" is a promise of a room that is not coming.
    assert.doesNotMatch(bodyText(), /Only .terrain\.3dm. is shared/,
      'the scope caption does not promise a share the mint will refuse');

    // Create link is not offered for a scope the mint refuses. Pressing it
    // used to confirm the scope, which locks the scope picker, and then mint
    // nothing: the owner could not go back to 'all' to share tower.ifc.
    assert.equal(createLinkButton()?.disabled, true, 'Create link is disabled while nothing in scope can be shared');

    click(scopeRadios()[1]!);
    await act(() => settle('going back to all models did not settle'));
    click(createLinkButton()!);
    await act(() => settle('room creation did not settle'));
    assert.equal(relay.mints().length, 1, 'with all models in scope the share goes ahead');
    assert.deepEqual(starts[0]?.seed?.models.map((m) => m.modelId), ['b'], 'carrying the IFC model only');
  });

  it('still mints for a GLB beside a .3dm: that workspace got an empty room on main', async (t) => {
    // The refusal is "every model in scope is one the seed must drop", not
    // "nothing is seedable". A GLB has no store and never seeded anything, so
    // this workspace minted an empty owner room on main and must keep doing
    // it — loading an unrelated `.3dm` beside it is not a reason to take the
    // owner's session away. The `.3dm` is still named.
    const { relay, beforeConsent } = await createLinkOver(
      t, makeModel('a', 'scan.glb', 0, 'none'), makeModel('b', 'terrain.3dm', 1_000_000, 'tabular'),
    );

    assert.match(beforeConsent, /Left out of the shared session, no IFC records to share from: terrain\.3dm\./,
      'the .3dm is named, but not as "nothing here can be shared"');
    assert.doesNotMatch(beforeConsent, /Nothing here can be shared/);
    assert.equal(relay.mints().length, 1, 'the empty owner room is still created, as on main');
    assert.deepEqual(starts[0]?.seed?.models, [], 'with an empty seed, which is the owner path (#4444)');
  });

  it('leaves a store-less workspace exactly as it was: a session, and nothing claimed about records', async (t) => {
    const { relay, beforeConsent } = await createLinkOver(t, makeModel('a', 'scan.glb', 0, 'none'));

    assert.doesNotMatch(beforeConsent, /IFC records to share from/, 'nothing had a store to drop, so nothing is named');
    assert.equal(relay.mints().length, 1, 'a GLB-only workspace still creates its room, as on main');
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0]?.seed?.models, [], 'the owner path takes an empty seed');
  });
});
