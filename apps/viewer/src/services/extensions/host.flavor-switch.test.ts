/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The host's end of the flavor-switch pointer write: `switchFlavor` turns a
 * failed switch into a thrown error and skips the lens / clash / sidebar
 * restores below it, so a refused pointer write that would have changed
 * nothing must not reach that branch.
 */

// fake-indexeddb backs the real IdbFlavorStorage / IdbExtensionStorage the
// host constructs for itself, so this exercises the production wiring.
import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import type { Flavor } from '@ifc-lite/extensions';
import { ExtensionHostService } from './host.js';
import { IdbFlavorStorage } from './idb-flavor-storage.js';

class TestHost extends ExtensionHostService {
  constructor() {
    super({
      sdk: createBimContext({
        transport: {
          send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
          subscribe: () => () => {},
          close: () => {},
        },
      }),
    });
  }
}

function flavor(id: string): Flavor {
  return {
    schemaVersion: 1,
    id,
    name: id,
    description: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    extensions: [],
    lenses: [],
    savedQueries: [],
    keybindings: [],
    layout: { state: {} },
    settings: {},
  };
}

/** Run `fn` with the flavor store's pointer write refused. */
async function withRefusedPointerWrite(fn: () => Promise<void>): Promise<void> {
  const original = IdbFlavorStorage.prototype.setActiveId;
  IdbFlavorStorage.prototype.setActiveId = () =>
    Promise.reject(new Error('pointer write refused'));
  try {
    await fn();
  } finally {
    IdbFlavorStorage.prototype.setActiveId = original;
  }
}

describe('ExtensionHostService.switchFlavor', () => {
  beforeEach(async () => {
    await new IdbFlavorStorage().clear();
  });

  it('does not throw when the refused pointer write already stored the target', async () => {
    const host = new TestHost();
    await host.flavors.put(flavor('flv.target'));
    await host.flavors.activate('flv.target');

    await withRefusedPointerWrite(async () => {
      // Re-applying the flavor that is already active: the pointer write
      // rewrites the id it already holds, so its refusal changed nothing.
      await host.switchFlavor('flv.target');
    });

    assert.equal(await host.flavors.activeId(), 'flv.target');
  });

  it('still throws when the refused pointer write would have moved the pointer', async () => {
    const host = new TestHost();
    await host.flavors.put(flavor('flv.target'));
    await host.flavors.put(flavor('flv.other'));
    await host.flavors.activate('flv.other');

    await withRefusedPointerWrite(async () => {
      await assert.rejects(
        () => host.switchFlavor('flv.target'),
        /Flavor switch failed for: <pointer>/,
      );
    });

    assert.equal(await host.flavors.activeId(), 'flv.other');
  });
});
