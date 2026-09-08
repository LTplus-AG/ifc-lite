/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The user-visible half of #3002: a flavor switch whose clash config could not
 * be applied must not toast an unqualified "Switched to X".
 *
 * The host's `switchFlavor` is stubbed here — what is under test is the
 * dialog's reading of the outcome, not the host's production of it (that is
 * `services/extensions/host.flavor-restore-refusal.test.ts`). The toast is
 * observed through a real `<Toaster/>` in the DOM rather than a spy on the
 * `toast` module, so the message the user actually reads is what is asserted.
 */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBimContext } from '@ifc-lite/sdk';
import type { Flavor } from '@ifc-lite/extensions';
import {
  ExtensionHostService,
  type FlavorSwitchOutcome,
} from '@/services/extensions/host.js';
import { IdbFlavorStorage } from '@/services/extensions/idb-flavor-storage.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { Toaster } from '@/components/ui/toast';
import { FlavorDialog } from './FlavorDialog.js';

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

class StubHost extends ExtensionHostService {
  outcome: FlavorSwitchOutcome = { unapplied: [] };
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
  override async switchFlavor(): Promise<FlavorSwitchOutcome> {
    return this.outcome;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/**
 * The row Activate buttons. The dialog renders through a portal, so the rows
 * live under document.body, not under the container the root was mounted into.
 */
function activateButtons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll('button')].filter(
    (b) => b.textContent?.trim() === 'Activate',
  );
}

/** Click the Activate button — `flv.a` is active, so `flv.b`'s is the only one. */
async function activate(): Promise<void> {
  const buttons = activateButtons();
  assert.equal(buttons.length, 1, 'expected exactly one inactive flavor row');
  await act(async () => {
    buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
  });
}

/**
 * The most recent toast's message. Read as "the last one" rather than "the
 * only one": toasts live in a module-level store with a timed dismissal, so an
 * earlier test's toast can still be on screen.
 */
function latestToast(): string {
  const stack = [...document.body.querySelectorAll('div')].find((d) =>
    d.className.includes('z-[9999]'),
  );
  assert.ok(stack, 'no toast was shown');
  const last = stack.children[stack.children.length - 1];
  return last?.textContent ?? '';
}

describe('FlavorDialog activate - reports a flavor part that was not applied', () => {
  let container: HTMLElement;
  let root: Root;
  let host: StubHost;

  beforeEach(async () => {
    await new IdbFlavorStorage().clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    host = new StubHost();
    await host.flavors.put(flavor('flv.a'));
    await host.flavors.put(flavor('flv.b'));
    await host.flavors.activate('flv.a');
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ExtensionHostContext.Provider value={host}>
          <FlavorDialog open onClose={() => {}} />
          <Toaster />
        </ExtensionHostContext.Provider>,
      );
    });
    // The dialog loads its list in an effect, behind IndexedDB reads that
    // settle on later macrotasks; flush until the rows are in the DOM. The
    // condition is the Activate button rather than the flavor id in the body
    // text: a toast left over from the previous test names the flavor too, and
    // waiting on that text let this proceed before any row existed.
    for (let i = 0; i < 200 && activateButtons().length === 0; i += 1) {
      await act(async () => {
        await tick();
      });
    }
    assert.equal(activateButtons().length, 1, 'flavor rows never rendered');
  });

  afterEach(async () => {
    // Unmount rather than wiping innerHTML: a live root whose DOM was deleted
    // out from under it renders nothing on the next mount.
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('names the unapplied part and its reason instead of a plain success', async () => {
    host.outcome = {
      unapplied: [{ part: 'clash', message: 'Browser storage is full — clash rules were not saved.' }],
    };
    await activate();

    const text = latestToast();
    assert.match(text, /Switched to flv\.b/);
    assert.match(text, /clash settings could not be applied/);
    assert.match(text, /clash rules were not saved/);
  });

  it('still reports a plain success when every part applied', async () => {
    host.outcome = { unapplied: [] };
    await activate();

    const text = latestToast();
    assert.match(text, /Switched to flv\.b/);
    assert.ok(!/could not be applied/.test(text), `reported a failure over a clean switch: ${text}`);
  });
});
