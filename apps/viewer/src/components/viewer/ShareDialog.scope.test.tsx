/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4444 — the Share dialog makes the federation scope explicit. With one
 * model there is nothing to choose and the room is created on open; with
 * several, the choice is shown, NO room is created until "Create link" is
 * pressed (a room's scope is fixed by its seed), and whichever scope is
 * picked is exactly what `startCollab` is asked to seed.
 *
 * Drives the real dialog: the effect mints a (local, serverless) token and
 * calls the store's `startCollab`, which is the one seam replaced here so the
 * seed it receives can be read back without a collab runtime. The stand-in
 * publishes `collabRoomId` synchronously like the real one, so the dialog
 * sees the room exist the moment it asks for it.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import type { StartCollabOptions } from '@/store/slices/collabSlice.js';
import { ShareDialog } from './ShareDialog.js';

function makeModel(id: string, name: string, idOffset: number, opts: { store?: boolean } = {}): FederatedModel {
  return {
    id,
    name,
    // `store: false` is a model with nothing to seed — a load still in flight
    // (`useIfcLoader` upserts the record with a null store first), a GLB or a
    // point cloud.
    ifcDataStore:
      opts.store === false
        ? null
        : ({
            schemaVersion: 'IFC4',
            __tag: id,
            // `prepareShareSeed` now preserves complete STEP sources only
            // when the real store reports authored annotations. Keep this
            // component fixture structurally valid at that production seam;
            // an absent index made room creation throw before `startCollab`.
            entityIndex: { byType: new Map() },
          } as unknown as FederatedModel['ifcDataStore']),
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

/** Let the dialog's async mint → startCollab chain settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function scopeRadios(): HTMLElement[] {
  const group = document.querySelector('[role="radiogroup"][aria-label="Share scope"]');
  return group ? Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]')) : [];
}
function createLinkButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Create link');
}
function linkField(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('#share-link');
  assert.ok(el, 'the dialog rendered its link field');
  return el;
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
      // The real `startCollab` records the room and its slots before any
      // await; the dialog's "room exists" branches key off exactly that.
      useViewerStore.setState({
        collabRoomId: opts.roomId,
        collabRole: opts.role,
        collabRoomModels: new Map(
          (opts.seed?.models ?? []).map((m, index) => [m.modelId, { slotId: `m${index}`, pathPrefix: `/m${index}` }]),
        ),
      });
    },
  });
});

afterEach(() => {
  cleanup();
  useViewerStore.setState({ startCollab: realStartCollab, models: new Map(), activeModelId: null });
});

describe('ShareDialog: explicit federation scope (#4444)', () => {
  it('offers no scope with one model, and creates the room on open seeding that model', async () => {
    useViewerStore.setState({ models: new Map([['a', makeModel('a', 'tower.ifc', 0)]]), activeModelId: 'a' });
    render(<ShareDialog open onOpenChange={() => {}} />);
    await settle();
    assert.equal(scopeRadios().length, 0, 'no choice to make with one model');
    assert.equal(createLinkButton(), undefined, 'nothing to confirm with one model');
    assert.ok(document.querySelector('#share-link'), 'the dialog rendered its link field');
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].seed?.models.map((m) => m.modelId), ['a']);
  });

  it('an owner with nothing seedable still takes the OWNER path: an empty seed, never none', async () => {
    // The Share button is enabled on `models.size > 0`, and a primary load
    // upserts its record before the store exists. `startCollab` keys owner vs
    // recipient on `seed` presence, so `undefined` here would send the admin
    // down the recipient path: reconstruct their own empty room as a ghost
    // 'Shared model' and count themselves a joiner of it.
    useViewerStore.setState({
      models: new Map([['a', makeModel('a', 'tower.ifc', 0, { store: false })]]),
      activeModelId: 'a',
    });
    render(<ShareDialog open onOpenChange={() => {}} />);
    await settle();
    assert.equal(starts.length, 1);
    assert.notEqual(starts[0].seed, undefined, 'the owner always passes a seed');
    assert.deepEqual(starts[0].seed, { models: [] });
  });

  it('"All loaded models" counts what can be shared, not what is loaded', async () => {
    useViewerStore.setState({
      models: new Map([
        ['a', makeModel('a', 'AC20-FZK-Haus.ifc', 0)],
        ['b', makeModel('b', 'site.glb', 1_000_000, { store: false })],
        ['c', makeModel('c', 'AC20-FZK-Haus.ifc', 2_000_000)],
      ]),
      activeModelId: 'a',
    });
    render(<ShareDialog open onOpenChange={() => {}} />);
    await settle();
    const radios = scopeRadios();
    assert.equal(radios[1].textContent?.trim(), 'All 2 of 3 loaded models');
    assert.match(document.body.textContent ?? '', /2 of 3 loaded models can be shared/);
    assert.match(document.body.textContent ?? '', /Share 2 models/);
    const create = createLinkButton();
    assert.ok(create);
    click(create);
    await settle();
    assert.deepEqual(starts[0].seed?.models.map((m) => m.modelId), ['a', 'c']);
    assert.match(document.body.textContent ?? '', /This room carries 2 models/);
  });

  it('with two copies loaded, asks first: no room until "Create link", then shares both — active first', async () => {
    useViewerStore.setState({
      models: new Map([
        ['a', makeModel('a', 'AC20-FZK-Haus.ifc', 0)],
        ['b', makeModel('b', 'AC20-FZK-Haus.ifc', 1_000_000)],
      ]),
      activeModelId: 'b',
    });
    render(<ShareDialog open onOpenChange={() => {}} />);
    await settle();
    const radios = scopeRadios();
    assert.equal(radios.length, 2);
    assert.equal(radios[1].textContent?.trim(), 'All 2 loaded models');
    assert.equal(radios[1].getAttribute('aria-checked'), 'true', '"all loaded models" is the default');
    for (const radio of radios) assert.equal((radio as HTMLButtonElement).disabled, false, 'the choice is live');
    assert.match(document.body.textContent ?? '', /Share 2 models/);
    assert.equal(starts.length, 0, 'the room is NOT created before the scope is confirmed');
    assert.equal(useViewerStore.getState().collabRoomId, null);
    assert.match(linkField().value, /Choose what to share/);

    const create = createLinkButton();
    assert.ok(create, 'the confirm button is offered');
    click(create);
    await settle();
    assert.equal(starts.length, 1, 'confirming creates the room once');
    const seed = starts[0].seed;
    assert.ok(seed);
    assert.deepEqual(seed.models.map((m) => m.modelId), ['b', 'a']);
    // Each model is seeded from ITS OWN store, not the top-level active one.
    assert.equal((seed.models[1].store as unknown as { __tag: string }).__tag, 'a');
    assert.equal(seed.models[0].idOffset, 1_000_000);
    // The room now exists: the scope is fixed and the dialog reports it.
    for (const radio of scopeRadios()) assert.equal((radio as HTMLButtonElement).disabled, true);
    assert.equal(createLinkButton(), undefined);
    assert.match(document.body.textContent ?? '', /This room carries 2 models/);
  });

  it('"Active model only" narrows the seed to the active model', async () => {
    useViewerStore.setState({
      models: new Map([
        ['a', makeModel('a', 'AC20-FZK-Haus.ifc', 0)],
        ['b', makeModel('b', 'AC20-FZK-Haus.ifc', 1_000_000)],
      ]),
      activeModelId: 'b',
    });
    render(<ShareDialog open onOpenChange={() => {}} />);
    await settle();
    click(scopeRadios()[0]);
    await settle();
    assert.equal(scopeRadios()[0].getAttribute('aria-checked'), 'true');
    assert.match(document.body.textContent ?? '', /Only “AC20-FZK-Haus.ifc” is shared/);
    assert.equal(starts.length, 0, 'picking a scope does not create the room by itself');
    const create = createLinkButton();
    assert.ok(create);
    click(create);
    await settle();
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].seed?.models.map((m) => m.modelId), ['b']);
    assert.match(document.body.textContent ?? '', /This room carries 1 model\./);
  });

  it('once the room exists the scope is fixed and the dialog reports what the room carries', async () => {
    useViewerStore.setState({
      models: new Map([
        ['a', makeModel('a', 'AC20-FZK-Haus.ifc', 0)],
        ['b', makeModel('b', 'AC20-FZK-Haus.ifc', 1_000_000)],
      ]),
      activeModelId: 'b',
      collabRoomId: 'room-1',
      collabRole: 'admin',
      collabRoomModels: new Map([
        ['b', { slotId: 'm0', pathPrefix: '/m0' }],
        ['a', { slotId: 'm1', pathPrefix: '/m1' }],
      ]),
    });
    render(<ShareDialog open onOpenChange={() => {}} />);
    await settle();
    for (const radio of scopeRadios()) assert.equal((radio as HTMLButtonElement).disabled, true);
    assert.match(document.body.textContent ?? '', /This room carries 2 models/);
    assert.equal(starts.length, 0, 'an existing room is never re-seeded from the dialog');
  });
});
