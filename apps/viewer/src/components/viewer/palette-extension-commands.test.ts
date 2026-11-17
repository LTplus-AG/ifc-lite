/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import type { CommandContribution, SlotContribution } from '@ifc-lite/extensions';
import { toast } from '@/components/ui/toast';
import { commandIdForAnalytics } from '@/lib/analytics-ui-events';
import { browseCommands, searchCommands } from './commandPaletteSearch';
import { buildPanelCommands } from './commandPaletteCommandsPanels';
import { PaletteCommandTestHost } from './__fixtures__/palette-extension-command';

afterEach(() => mock.restoreAll());
const settle = () => new Promise(resolve => setImmediate(resolve));

// Exercise the existing production entry, including when the new implementation is reverted.
function extensionRows(contributions: SlotContribution<CommandContribution>[], host: PaletteCommandTestHost | null) {
  return buildPanelCommands({
    execute: () => {}, recentFiles: [], cachedNames: { current: new Set<string>() },
    extensionCommands: contributions, extensionHost: host, canEditInSession: true,
    cesiumAvailable: false, activateRightPanel: () => {}, activateBottomPanel: () => {}, runExport: () => {},
  }).filter(row => row.runtimeSource === 'extension-command');
}


test('#8947 colliding manifest commands keep owner, description, category and one canonical dispatch', async () => {
  const host = new PaletteCommandTestHost();
  host.add('alpha'); host.add('beta');
  const rows = extensionRows(host.slotRegistry.getAll<CommandContribution>('commandPalette'), host);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  const delimiters = new PaletteCommandTestHost(); delimiters.add('a:b', 'c'); delimiters.add('a', 'b:c');
  const tupleRows = extensionRows(delimiters.slotRegistry.getAll<CommandContribution>('commandPalette'), delimiters);
  assert.equal(tupleRows.length, 2);
  assert.notEqual(tupleRows[0].id, tupleRows[1].id, 'owner/command tuple cannot collide at a delimiter');
  assert.match(rows[0].detail ?? '', /alpha/);
  assert.match(rows[1].detail ?? '', /beta/);
  for (const query of ['audit compliance', 'Quality', 'paint', 'beta']) {
    assert.ok(searchCommands(rows, query, []).some(row => row.id === rows[1].id), query);
  }
  assert.equal(browseCommands(rows, ['ext:paint']).grouped.some(g => g.category === 'Recent'), false);
  assert.equal(browseCommands(rows, [rows[1].id]).grouped[0].items[0].cmd, rows[1]);
  assert.equal(commandIdForAnalytics(rows[1].id), 'ext-command', 'owner is never a plain analytics id');
  // Toolbar's selection predicate does not restrict the command itself.
  for (const row of rows) {
    assert.deepEqual(row.checkAvailability?.(), { status: 'available' });
    row.action();
    await settle();
  }
  assert.deepEqual(host.executions, ['alpha', 'beta']);
  assert.deepEqual(host.activations, ['alpha', 'beta']);
  assert.deepEqual(host.events, ['onCommand:paint', 'onCommand:paint']);
});

test('#8947 null host and replaced contributions refuse; async host rejection stays visible', async () => {
  const host = new PaletteCommandTestHost(); host.add('alpha');
  const contributions = host.slotRegistry.getAll<CommandContribution>('commandPalette');
  const [missing] = extensionRows(contributions, null);
  assert.deepEqual(missing.checkAvailability?.(), { status: 'disabled', reasonKey: 'commandPalette.availability.host' });
  const errors: string[] = [];
  mock.method(toast, 'error', (message: string) => { errors.push(message); });
  missing.action();
  assert.equal(errors.length, 1, 'missing host cannot silently return');
  const [stale] = extensionRows(contributions, host);
  host.slotRegistry.unregister('alpha'); host.add('alpha');
  assert.deepEqual(stale.checkAvailability?.(), { status: 'disabled', reasonKey: 'commandPalette.availability.feature' });
  stale.action();
  assert.deepEqual(host.events, []);
  assert.deepEqual(host.activations, []);
  host.failure = new Error('Grant was revoked');
  const [fresh] = extensionRows(host.slotRegistry.getAll<CommandContribution>('commandPalette'), host);
  fresh.action(); await settle();
  assert.match(errors.at(-1) ?? '', /Grant was revoked/);
  assert.deepEqual(host.activations, ['alpha'], 'no retry or second sandbox on ordinary refusal');
  assert.deepEqual(host.executions, []);
});
