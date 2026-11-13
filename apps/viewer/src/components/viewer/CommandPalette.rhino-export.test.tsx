/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The palette's `export:3dm` row: found by "Rhino", opens the Rhino dialog,
 * and is gated like `export:usd` (a model must be loaded; a retained-kernel
 * model refuses it, since the export re-meshes the file with the exact engine).
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider.js';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { RETAINED_EXACT_ONLY_REASON } from '@/store/retainedGeometry';
import { advance, cleanup, render, type as typeInto, waitFor } from '@/test/render.js';
import { CommandPaletteHost } from './CommandPaletteHost.js';
import { buildExportCommands } from './commandPaletteExports.js';

function model(retained = false): FederatedModel {
  return {
    id: 'm', name: 'house.ifc', ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 1, fileSize: 1, sourceFile: new File([new Uint8Array([1])], 'house.ifc'),
    idOffset: 0, maxExpressId: 1,
    ...(retained ? { retainedGeometry: { kernel: 'retained', candidates: 1, published: 1, refused: [], cancelled: 0, obligationsUnmet: [], completeness: 'complete' } } : {}),
  } as FederatedModel;
}

function rhinoRow() {
  const row = buildExportCommands(() => undefined).find((c) => c.id === 'export:3dm');
  assert.ok(row, 'the palette has an export:3dm row');
  return row;
}

after(cleanup);
beforeEach(() => {
  cleanup();
  useViewerStore.setState({ models: new Map([['m', model()]]), activeModelId: 'm', ifcDataStore: null });
});
after(() => { useViewerStore.setState({ models: new Map(), activeModelId: null }); });

describe('CommandPalette — export:3dm', () => {
  it('is labelled "Export Rhino (.3dm)" and available with a loaded model', () => {
    const row = rhinoRow();
    assert.equal(row.label, 'Export Rhino (.3dm)');
    assert.deepEqual(row.availability, { status: 'available' });
  });

  it('is disabled with the exact-only reason while a retained model is loaded, like USD', () => {
    useViewerStore.setState({ models: new Map([['m', model(true)]]) });
    const rows = buildExportCommands(() => undefined);
    for (const id of ['export:3dm', 'export:usd']) {
      assert.deepEqual(rows.find((c) => c.id === id)?.availability, { status: 'disabled', reasonKey: RETAINED_EXACT_ONLY_REASON }, id);
    }
  });

  it('is disabled when nothing is loaded', () => {
    useViewerStore.setState({ models: new Map(), activeModelId: null });
    assert.equal(rhinoRow().availability?.status, 'disabled');
  });

  it('running it from the palette opens the Rhino export dialog', async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <BimReactContext.Provider value={{} as BimContext}>
          <CommandPaletteHost open={open} onOpenChange={setOpen} />
        </BimReactContext.Provider>
      );
    }
    render(<Host />);
    await waitFor(() => document.body.querySelector('[role="combobox"]') !== null, 'the palette opens');
    const input = document.body.querySelector<HTMLInputElement>('[role="combobox"]');
    assert.ok(input);
    typeInto(input, 'rhino');
    const option = [...document.body.querySelectorAll('[role="option"]')].find(
      (el) => (el.textContent ?? '').includes('Export Rhino (.3dm)'),
    );
    assert.ok(option, `no Rhino row; saw ${[...document.body.querySelectorAll('[role="option"]')].map((el) => el.textContent).join(' | ')}`);
    act(() => {
      option.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    const title = 'Export Rhino (.3dm)'; // literal, not the catalogue the dialog renders from
    await waitFor(() => [...document.body.querySelectorAll('[role="dialog"]')]
      // The palette is a dialog too and shows the same label; skip the one holding its input.
      .some((d) => !d.contains(input) && d.textContent?.includes(title) && d.textContent?.includes('Units')), 'the Rhino dialog opens');
    await advance(20);
  });
});
