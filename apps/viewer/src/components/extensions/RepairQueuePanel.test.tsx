/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rendering tests for `RepairQueuePanel` — the header/row invariant.
 *
 * The panel prints "<n> need fixing" from `summary.needsRepair.length`
 * and decides per row whether to render a Repair button. Those two
 * decisions used to be made by two separate copies of the same
 * predicate, one in `revalidateAgainstSdk` and one in this file; when
 * only the first was widened to cover permissive-but-unverifiable
 * extensions, the header started counting rows the user had no way to
 * act on. Both now call the exported `needsSdkRepair`, and this test
 * pins the property that made the divergence a bug: the header count
 * equals the number of actionable rows.
 *
 * happy-dom provides the DOM (registered by `@/test/setup-dom.js`,
 * which must stay the first import); React 19's `createRoot` + `act()`
 * drive the component for real. The host is a real
 * `ExtensionHostService` subclass with only `revalidateForSdk`
 * overridden — the genuine one needs IndexedDB and a QuickJS sandbox.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { needsSdkRepair } from '@ifc-lite/extensions';
import type {
  Compatibility,
  RevalidationItem,
  RevalidationSummary,
} from '@ifc-lite/extensions';
import { createBimContext } from '@ifc-lite/sdk';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { RepairQueuePanel } from './RepairQueuePanel.js';

const SDK = '2.0.0';

class StubExtensionHost extends ExtensionHostService {
  summary: RevalidationSummary = { sdk: SDK, items: [], needsRepair: [] };

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

  override revalidateForSdk(): Promise<RevalidationSummary> {
    return Promise.resolve(this.summary);
  }
}

function item(
  extensionId: string,
  outcome: RevalidationItem['outcome'],
  status: Compatibility,
): RevalidationItem {
  return {
    extensionId,
    outcome,
    compatibility: {
      extensionId,
      declared: status === 'permissive' ? '*' : '^1.0.0',
      sdk: SDK,
      status,
      reason: `${status} range`,
    },
  };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderPanel(host: ExtensionHostService): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ExtensionHostContext.Provider value={host}>
        <RepairQueuePanel sdkVersion={SDK} />
      </ExtensionHostContext.Provider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

/** Click the panel's "Run check" button and let the promise settle. */
async function runCheck(container: HTMLElement): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Run check'),
  );
  assert.ok(button, 'expected a "Run check" button before any summary exists');
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

/** The "<n> need fixing" number printed in the header. */
function headerCount(container: HTMLElement): number {
  const match = /(\d+) need fixing/.exec(container.textContent ?? '');
  assert.ok(match, `header must print a "need fixing" count; got: ${container.textContent}`);
  return Number(match[1]);
}

/** Rows offering the user a Repair button. */
function repairButtonCount(container: HTMLElement): number {
  return [...container.querySelectorAll('button')].filter((b) =>
    b.textContent?.includes('Repair'),
  ).length;
}

describe('RepairQueuePanel header/row agreement', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('the header count equals the number of rows offering a Repair button', async () => {
    const host = new StubExtensionHost();
    const items = [
      item('ext.pass', 'pass', 'compatible'),
      item('ext.failed', 'fail', 'outdated'),
      item('ext.skipped-outdated', 'skipped', 'outdated'),
      // A permissive extension (wildcard range) with no declared tests:
      // the queue counts it, so the row must offer the fix.
      item('ext.skipped-permissive', 'skipped', 'permissive'),
    ];
    host.summary = {
      sdk: SDK,
      items,
      // Built the way `revalidateAgainstSdk` builds it, so the header
      // reflects the real queue rule rather than a copy of it here.
      needsRepair: items.filter(needsSdkRepair),
    };

    const container = renderPanel(host);
    await runCheck(container);

    assert.equal(headerCount(container), 3, 'fixture must exercise a non-empty repair queue');
    assert.equal(
      repairButtonCount(container),
      headerCount(container),
      'every extension counted in the header must have an actionable Repair button',
    );
  });

  it('a queue with nothing to fix renders no Repair buttons', async () => {
    const host = new StubExtensionHost();
    const items = [item('ext.pass', 'pass', 'compatible')];
    host.summary = { sdk: SDK, items, needsRepair: [] };

    const container = renderPanel(host);
    await runCheck(container);

    assert.equal(headerCount(container), 0);
    assert.equal(repairButtonCount(container), 0);
  });
});
