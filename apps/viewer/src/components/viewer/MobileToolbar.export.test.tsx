/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5842: the mobile overflow menu's Export sheet is the export registry. On
 * main it offered one private one-click GLB export (a `quick-glb` path the
 * GLB dialog had already superseded), gated on the legacy single-model
 * `geometryResult`, so it vanished in a multi-model session and no other
 * format was reachable on a phone.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { render, cleanup, click, advance, press } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { EXPORT_COMMANDS } from './toolbar/export-commands';
import { MobileToolbar } from './MobileToolbar';

const initialState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState);
});

/** Two federated models and no legacy single-model `geometryResult`. */
function seedFederation(): void {
  useViewerStore.setState({
    ...fixtureModels(fixtureModel('a', { idOffset: 0 }), fixtureModel('b', { idOffset: 1000 })),
    geometryResult: null,
    loading: false,
  });
}

async function openExportSheet(): Promise<void> {
  render(<BimReactContext.Provider value={{} as BimContext}><MobileToolbar /></BimReactContext.Provider>);
  const more = document.querySelector<HTMLElement>('[aria-label="More actions"]');
  assert.ok(more, 'the More actions button renders');
  press(more, 'ArrowDown'); await advance(10);
  assert.ok(document.querySelector('[data-mobile-export-menu]'), 'the overflow menu has an Export section');
}

function exportRowIds(): string[] {
  return [...document.querySelectorAll('[data-export-row]')].map((el) => el.getAttribute('data-export-row') ?? '');
}

describe('mobile Export sheet is the export registry (#5842)', () => {
  it('lists every registry format, CSV per table, in a multi-model session', async () => {
    seedFederation();
    await openExportSheet();
    const expected = EXPORT_COMMANDS.flatMap((c) => c.kind === 'table-menu'
      ? c.items.map((item) => `export:csv-${item.type}`)
      : [`export:${c.id}`]);
    assert.deepEqual(exportRowIds(), expected);
  });

  it('GLB opens the GLB export dialog, the one every other surface uses', async () => {
    seedFederation();
    await openExportSheet();
    const glb = document.querySelector<HTMLElement>('[data-export-row="export:glb"]');
    assert.ok(glb, 'a GLB row is offered with two models loaded');
    click(glb); await advance(20);
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, 'the GLB dialog opens');
    assert.match(dialog.textContent ?? '', /GLB/);
  });
});
