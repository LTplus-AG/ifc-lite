/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5815: extension tablists support keyboard selection and name their panels. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { advance, cleanup, press, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { extensionsFlavorsEn } from '@/i18n/catalogues/extensions-flavors.en';
import { ExtensionHostService, type ExtensionInstallSummary } from '@/services/extensions/host.js';
import { IdbFlavorStorage } from '@/services/extensions/idb-flavor-storage.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { CapabilityReview } from './CapabilityReview.js';
import { ExtensionDockHost } from './ExtensionDockHost.js';
import { ExtensionsPanel } from './ExtensionsPanel.js';

class StubHost extends ExtensionHostService {
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

function capabilitySummary(): ExtensionInstallSummary {
  return {
    id: 'com.example.fire-rating',
    version: '1.2.0',
    bundleHash: 'a'.repeat(64),
    capabilities: ['model.read'],
    bundle: {
      manifest: {
        manifestVersion: 1,
        id: 'com.example.fire-rating',
        name: 'Fire rating report',
        description: 'test fixture',
        version: '1.2.0',
        engines: { ifcLiteSdk: '>=1.0.0' },
        capabilities: ['model.read'],
        activation: ['onCommand:run'],
        contributes: { commands: [{ id: 'run', title: 'Run' }] },
        entry: { commands: { run: 'src/run.js' } },
      },
      files: new Map(),
      source: { kind: 'memory' },
    },
    signed: false,
  };
}

async function expectArrowSelection(tabs: HTMLElement[], panelRoot: ParentNode): Promise<void> {
  assert.ok(tabs.length > 1);
  act(() => tabs[0].focus());
  press(tabs[0], 'ArrowRight');
  await advance(5);
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, tabs[1]);
  const panel = panelRoot.querySelector('[role="tabpanel"]');
  assert.ok(panel);
  assert.equal(panel.getAttribute('aria-labelledby'), tabs[1].id);
}

beforeEach(async () => {
  registerLocale('extensions-tabs-keyboard', extensionsFlavorsEn as Catalogue);
  setLocale('extensions-tabs-keyboard');
  await new IdbFlavorStorage().clear();
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('extension tabs keyboard behavior (#5815)', () => {
  it('selects Ideas and labels its panel with ArrowRight', async () => {
    const host = new StubHost();
    const ui = render(
      <ExtensionHostContext.Provider value={host}>
        <ExtensionsPanel />
      </ExtensionHostContext.Provider>,
    );
    await advance(5);
    const tabs = [...ui.querySelectorAll<HTMLElement>('[role="tab"]')];
    assert.equal(tabs.length, 4);
    await expectArrowSelection(tabs, ui);
  });

  it('selects the second dock widget even when payload IDs match', async () => {
    const host = new StubHost();
    host.slotRegistry.register('ext.a', [
      { extensionId: 'ext.a', slot: 'dock.left', payload: { id: 'd1', slot: 'dock.left', title: 'First Widget', widget: 'first.json' } },
    ]);
    host.slotRegistry.register('ext.b', [
      { extensionId: 'ext.b', slot: 'dock.left', payload: { id: 'd1', slot: 'dock.left', title: 'Second Widget', widget: 'second.json' } },
    ]);
    const ui = render(
      <ExtensionHostContext.Provider value={host}>
        <ExtensionDockHost slot="dock.left" />
      </ExtensionHostContext.Provider>,
    );
    const tabs = [...ui.querySelectorAll<HTMLElement>('[role="tab"]')];
    assert.equal(tabs.length, 2);
    await expectArrowSelection(tabs, ui);
  });

  it('opens the capability Source panel with ArrowRight', async () => {
    render(<CapabilityReview open summary={capabilitySummary()} onApprove={() => {}} onCancel={() => {}} />);
    const tabs = [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')];
    assert.equal(tabs.length, 2);
    act(() => tabs[0].focus());
    press(tabs[0], 'ArrowRight');
    await advance(5);
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement, tabs[1]);
    const panel = document.body.querySelector('[role="tabpanel"]');
    assert.ok(panel);
    assert.equal(panel.getAttribute('aria-labelledby'), tabs[1].id);
  });
});
