/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reload-to-apply for load-time geometry settings re-runs `loadFile` on the
 * active model's retained File. A model opened by reference from the
 * processing server has no File: it must neither re-load an empty stand-in
 * nor reload the page (which drops a model a host opened in code).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { reloadActiveModelInPlace } from './reloadActiveModel';

let loads: File[], notices: number, pageReloads: number;
const loadFile = async (file: File) => { loads.push(file); };
const originalLocation = window.location;

beforeEach(() => {
  loads = []; notices = 0; pageReloads = 0;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload: () => { pageReloads++; } } });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  useViewerStore.getState().clearAllModels();
});

function activate(patch: Record<string, unknown>): void {
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ...patch } as ReturnType<typeof fixtureModel>), activeModelId: 'm' });
}

describe('reloadActiveModelInPlace', () => {
  it('re-loads the retained source File', async () => {
    const file = new File(['ISO-10303-21;'], 'local.ifc');
    activate({ sourceFile: file });
    await reloadActiveModelInPlace(loadFile, 'test', () => { notices++; });
    assert.deepEqual(loads, [file]);
    assert.equal(notices, 0);
    assert.equal(pageReloads, 0);
  });

  it('tells the user a server-processed model is unchanged, and loads nothing', async () => {
    activate({ processedModel: { sha256: 'a'.repeat(64), bytes: 1000 } });
    await reloadActiveModelInPlace(loadFile, 'test', () => { notices++; });
    assert.deepEqual(loads, [], 'no load on zero bytes');
    assert.equal(notices, 1);
    assert.equal(pageReloads, 0, 'a page reload would drop a model opened in code');
  });

  it('falls back to a page reload for a model with no source of either kind', async () => {
    activate({});
    await reloadActiveModelInPlace(loadFile, 'test', () => { notices++; });
    assert.deepEqual(loads, []);
    assert.equal(pageReloads, 1);
  });
});
