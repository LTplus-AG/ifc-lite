/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import assert from 'node:assert/strict';
import { beforeEach, afterEach, it } from 'node:test';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { seedModelingSession, MODEL_ID, STOREY } from '@/test/modeling-session-fixture';
import { cleanup, click, render, waitFor } from '@/test/render';
import { WORKSPACE_SURFACE_COMMANDS } from '../../surface-commands-workspace';
import { paletteAvailability } from '../../palette-availability';
import { Toaster } from '@/components/ui/toast';
import { CopyToStoreys } from './CopyToStoreys';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
let restore = () => {};
beforeEach(async () => {
  await seedModelingSession();
  restore = setRequestRemesh(() => {});
  const result = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in result);
  useViewerStore.getState().setSelectedEntityId(result.expressId);
});
afterEach(() => {
  restore();
  const notices = render(<Toaster />);
  for (const b of notices.querySelectorAll<HTMLButtonElement>('[aria-label="Dismiss notification"]')) click(b);
  cleanup();
});
const button = (ui: HTMLElement, text: string) => [...ui.querySelectorAll('button')].find(b => b.textContent === text)!;
const walls = () => useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities().filter(e => e.type.toUpperCase() === 'IFCWALL');
it('#9296 copies a selection to a set of storeys atomically and undoes all copies together', async () => {
  const before = walls().length;
  const ui = render(<CopyToStoreys />);
  click(button(ui, 'Select all storeys'));
  click(button(ui, 'Prepare copies'));
  await waitFor(() => !!button(ui, 'Copy now'), 'prepared');
  const stack = useViewerStore.getState().undoStacks.get(MODEL_ID)!.length;
  click(button(ui, 'Copy now'));
  assert.match(ui.textContent ?? '', /Copying…/, '#9296 busy feedback is visible before the atomic write');
  assert.equal(walls().length, before);
  await waitFor(() => walls().length === before + 2, 'copies committed after busy feedback');
  // The store adapter tags every created product as a single undo batch.
  assert.ok(useViewerStore.getState().undoStacks.get(MODEL_ID)!.length > stack);
  act(() => { useViewerStore.getState().undo(MODEL_ID); });
  const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
  assert.equal(walls().filter(w => !view.isDeleted(w.expressId)).length, before);
});
it('#9296 cancelling preparation creates no entities or history', async () => {
  const ui = render(<CopyToStoreys />);
  const before = walls().length;
  const stack = useViewerStore.getState().undoStacks.get(MODEL_ID)!.length;
  click(button(ui, 'Select all storeys'));
  click(button(ui, 'Prepare copies'));
  click(button(ui, 'Cancel'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(walls().length, before);
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)!.length, stack);
  assert.equal(button(ui, 'Copy now'), undefined);
});

it('#9334 the canonical palette entry requires a real model session as well as editing permission', () => {
  const command = WORKSPACE_SURFACE_COMMANDS.find(c => c.id === 'model:copy-to-storeys')!;
  const availability = () => paletteAvailability(command, { surface: 'palette' });
  act(() => { useViewerStore.getState().exitModelWorkspace(); });
  assert.equal(command.enabled({ canEditInSession: true }), true, 'the command stays discoverable');
  assert.deepEqual(availability(), { status: 'disabled', reasonKey: 'commandPalette.availability.ifc' });
  act(() => { useViewerStore.getState().enterModelWorkspace({ modelId: MODEL_ID, storeyId: STOREY }); });
  assert.deepEqual(availability(), { status: 'available' });
  act(() => { useViewerStore.getState().setSelectedEntityIds([]); });
  assert.deepEqual(availability(), { status: 'disabled', reasonKey: 'commandPalette.availability.selection' });
  act(() => { useViewerStore.setState({ editEnabled: false }); });
  assert.deepEqual(availability(), { status: 'disabled', reasonKey: 'commandPalette.availability.editor' });
  act(() => { useViewerStore.setState({ editEnabled: true }); });
  assert.equal(command.enabled({ canEditInSession: false }), false);
  act(() => { useViewerStore.getState().exitModelWorkspace(); });
});

it('#9334 read-only copy controls explain the denial and discard a prepared batch', async () => {
  act(() => { useViewerStore.setState({ editEnabled: false }); });
  const ui = render(<CopyToStoreys />);
  assert.equal(button(ui, 'Prepare copies').disabled, true);
  assert.match(ui.textContent ?? '', /Copying is unavailable/);
  const before = walls().length;
  const stack = useViewerStore.getState().undoStacks.get(MODEL_ID)!.length;
  act(() => { useViewerStore.setState({ editEnabled: true }); });
  click(button(ui, 'Select all storeys'));
  click(button(ui, 'Prepare copies'));
  await waitFor(() => !!button(ui, 'Copy now'), 'prepared');
  act(() => { useViewerStore.setState({ editEnabled: false }); });
  assert.equal(button(ui, 'Copy now'), undefined, 'revocation discards preparation');
  assert.equal(button(ui, 'Prepare copies').disabled, true);
  click(button(ui, 'Prepare copies'));
  assert.equal(walls().length, before);
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)!.length, stack);
});

it('#9296 closing the picker before the painted commit writes no copies', async () => {
  const ui = render(<CopyToStoreys />);
  const before = walls().length;
  const stack = useViewerStore.getState().undoStacks.get(MODEL_ID)!.length;
  click(button(ui, 'Select all storeys'));
  click(button(ui, 'Prepare copies'));
  await waitFor(() => !!button(ui, 'Copy now'), 'prepared');
  click(button(ui, 'Copy now'));
  cleanup();
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(walls().length, before);
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)!.length, stack);
});

it('#9334 copy completion offers Show and Undo, revealing hidden storeys and undoing only this copy', async () => {
  act(() => useViewerStore.getState().setStoreyContextMode('hide'));
  const ui = render(<><CopyToStoreys /><Toaster /></>);
  const before = walls().length;
  click(button(ui, 'Select all storeys'));
  click(button(ui, 'Prepare copies'));
  await waitFor(() => !!button(ui, 'Copy now'), 'prepared');
  assert.match(ui.textContent ?? '', /1 wall × 2 storeys = 2 new elements/);
  click(button(ui, 'Copy now'));
  await waitFor(() => !!button(ui, 'Show'), 'completion toast');
  assert.match(ui.textContent ?? '', /Copied 2 elements to 2 storeys/);
  assert.ok(button(ui, 'Undo'));
  click(button(ui, 'Show'));
  await waitFor(() => useViewerStore.getState().storeyContextMode === 'all', 'the first-click Show action loads');
  assert.equal(useViewerStore.getState().storeyContextMode, 'all');
  assert.equal(useViewerStore.getState().levelDisplayMode, 'stacked');
  assert.ok(button(ui, 'Undo'), 'Show keeps Undo available');
  click(button(ui, 'Undo'));
  await waitFor(() => walls().filter(w => !useViewerStore.getState().mutationViews.get(MODEL_ID)!.isDeleted(w.expressId)).length === before, 'the clicked Undo action completes');
  assert.equal(walls().filter(w => !useViewerStore.getState().mutationViews.get(MODEL_ID)!.isDeleted(w.expressId)).length, before);
});

it('#9334 the prepared summary itemises a mixed wall and beam selection', async () => {
  const s = useViewerStore.getState();
  s.setSelectedEntityIds([s.selectedEntityId!, 80]);
  const ui = render(<CopyToStoreys />);
  click(button(ui, 'Select all storeys'));
  click(button(ui, 'Prepare copies'));
  await waitFor(() => !!button(ui, 'Copy now'), 'prepared');
  assert.match(ui.textContent ?? '', /1 wall/);
  assert.match(ui.textContent ?? '', /1 × Beam/);
  assert.match(ui.textContent ?? '', /× 2 storeys = 4 new elements/);
});

it('#9334 the copy toast refuses Undo with an explanation after editing permission is revoked', async () => {
  const ui = render(<><CopyToStoreys /><Toaster /></>);
  click(button(ui, 'Select all storeys')); click(button(ui, 'Prepare copies'));
  await waitFor(() => !!button(ui, 'Copy now'), 'prepared');
  click(button(ui, 'Copy now'));
  await waitFor(() => !!button(ui, 'Undo'), 'completion toast');
  const depth = useViewerStore.getState().undoStacks.get(MODEL_ID)!.length;
  act(() => useViewerStore.setState({ editEnabled: false }));
  click(button(ui, 'Undo'));
  await waitFor(() => /Copying is unavailable/.test(ui.querySelector('[role="alert"]')?.textContent ?? ''), 'the lazy Undo action checks current editing permission');
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)!.length, depth);
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /Copying is unavailable/);
});
