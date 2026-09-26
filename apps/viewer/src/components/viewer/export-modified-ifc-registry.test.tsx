/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5838: "Export modified IFC…" is an export-registry entry, so the classic
 * menu, the ribbon and the command palette reach it — on main it was only the
 * amber toolbar button mounted beside the registry cluster. It is gated on
 * pending edits, and every surface opens the same review dialog.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ClassicExportMenuItems } from './toolbar/ClassicExportMenuItems';
import { buildExportCommands } from './commandPaletteExports';
import { usePaletteExportRunner } from './usePaletteExportRunner';

function model(): FederatedModel {
  return {
    id: 'model-1', name: 'model-1.ifc', ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 1, fileSize: 3, sourceFile: new File([new Uint8Array([1, 2, 3])], 'model-1.ifc'),
    idOffset: 0, maxExpressId: 0,
  };
}

function seed(edited: boolean): void {
  const view = new MutablePropertyView(null, 'model-1');
  view.setOnDemandExtractor((id) => id === 7 ? [{
    name: 'Pset_Base', globalId: 'g', properties: [{ name: 'Status', type: PropertyValueType.Label, value: 'Original' }],
  }] : []);
  if (edited) view.setProperty(7, 'Pset_Base', 'Status', 'Edited', PropertyValueType.Label);
  useViewerStore.setState({
    models: new Map([['model-1', model()]]), mutationViews: new Map([['model-1', view]]), mutationVersion: edited ? 1 : 0,
    georefMutations: new Map(), scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null, ifcDataStore: null,
  });
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function mount(node: React.ReactNode): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
  mounted.push({ root, container });
}

function renderClassicMenu(): void {
  mount(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>Export</DropdownMenuTrigger>
      <DropdownMenuContent><ClassicExportMenuItems /></DropdownMenuContent>
    </DropdownMenu>,
  );
}

function menuRow(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-export-command="modified-ifc"]');
}

const reviewOpen = () => document.body.querySelector('[role="dialog"]') !== null;

let runner: ReturnType<typeof usePaletteExportRunner> | null = null;
function RunnerHarness() {
  runner = usePaletteExportRunner();
  return runner.dialog;
}

describe('Export modified IFC… is a registry entry (#5838)', () => {
  beforeEach(() => { runner = null; });
  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('the classic menu offers it, disabled while nothing is edited', () => {
    seed(false);
    renderClassicMenu();
    const row = menuRow();
    assert.ok(row, 'the menu renders an Export modified IFC… row');
    assert.equal(row.getAttribute('aria-disabled'), 'true');
  });

  it('the classic menu row opens the review when there are edits', async () => {
    seed(true);
    renderClassicMenu();
    const row = menuRow();
    assert.ok(row);
    assert.equal(row.getAttribute('aria-disabled'), null);
    assert.ok(row.textContent?.includes('Export modified IFC…'));
    await act(async () => { row.click(); });
    assert.ok(reviewOpen(), 'the review dialog opens');
    assert.ok(document.body.textContent?.includes('Edited'), 'it lists the pending edit');
  });

  it('the palette row opens the same review', async () => {
    seed(true);
    mount(<RunnerHarness />);
    assert.ok(runner);
    const row = buildExportCommands(runner.runExport).find((c) => c.id === 'export:modified-ifc');
    assert.ok(row, 'the palette offers Export modified IFC…');
    await act(async () => { row.action(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.ok(reviewOpen(), 'the review dialog opens from the palette');
  });
});
