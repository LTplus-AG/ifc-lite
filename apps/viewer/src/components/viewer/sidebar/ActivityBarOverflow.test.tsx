/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The activity rail's overflow menu (#8802 R1 review and council): the trigger
 * says what it is on sight ("More" plus the count), and every listed panel
 * names its open / floating / popped-out state in words, as the rail icons do
 * through `aria-pressed` and their location labels, never by colour alone.
 */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render';
import { resolve } from '@/i18n/registry';
import type { PanelLocation } from '@/hooks/usePanelControls';
import { WORKSPACE_PANELS, type WorkspacePanelId } from '@/lib/panels/registry';
import { ActivityBarOverflow } from './ActivityBarOverflow';

afterEach(cleanup);

const [docked, floating, popped, closed] = WORKSPACE_PANELS.slice(0, 4);
const LOCATIONS = new Map<WorkspacePanelId, PanelLocation>([
  [docked.id, 'docked'], [floating.id, 'floating'], [popped.id, 'popped'], [closed.id, 'closed'],
]);
const ids = [docked.id, floating.id, popped.id, closed.id];

function openMenu(trigger: HTMLElement): void {
  act(() => {
    trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  });
  click(trigger);
}

it('labels the trigger visibly and keeps its count (#8802 council)', () => {
  const container = render(<ActivityBarOverflow ids={ids} locationOf={(id) => LOCATIONS.get(id) ?? 'closed'} onSelect={() => {}} />);
  const trigger = container.querySelector<HTMLButtonElement>('[data-rail-overflow]');
  assert.ok(trigger);
  assert.equal(container.querySelector('[data-rail-overflow-caption]')?.textContent, resolve('shellChrome.activityBar.moreCaption'));
  assert.match(trigger.textContent ?? '', /\+4/, 'the hidden-panel count stays visible');
  // Some listed panels are open, and the name says so instead of only a dot.
  assert.equal(trigger.getAttribute('aria-label'), resolve('shellChrome.activityBar.morePanelsSomeOpen', { count: 4 }));
});

it('names the trigger without the open note when every listed panel is closed', () => {
  const container = render(<ActivityBarOverflow ids={[closed.id]} locationOf={() => 'closed'} onSelect={() => {}} />);
  const trigger = container.querySelector<HTMLButtonElement>('[data-rail-overflow]');
  assert.equal(trigger?.getAttribute('aria-label'), resolve('shellChrome.activityBar.morePanels', { count: 1 }));
});

it('names each listed panel with its location, like the rail icons', () => {
  const selected: WorkspacePanelId[] = [];
  const container = render(
    <ActivityBarOverflow ids={ids} locationOf={(id) => LOCATIONS.get(id) ?? 'closed'} onSelect={(id) => selected.push(id)} />,
  );
  const trigger = container.querySelector<HTMLButtonElement>('[data-rail-overflow]');
  assert.ok(trigger);
  openMenu(trigger);
  const row = (id: WorkspacePanelId) => document.querySelector<HTMLElement>(`[role="menuitem"][data-panel-id="${id}"]`);
  const title = (panel: (typeof WORKSPACE_PANELS)[number]) => resolve(panel.titleKey);

  assert.equal(row(docked.id)?.getAttribute('aria-label'), resolve('shellChrome.activityBar.iconAriaLabelOpen', { title: title(docked) }));
  assert.equal(row(floating.id)?.getAttribute('aria-label'), resolve('shellChrome.activityBar.iconAriaLabelFloating', { title: title(floating) }));
  assert.equal(row(popped.id)?.getAttribute('aria-label'), resolve('shellChrome.activityBar.iconAriaLabelPopped', { title: title(popped) }));
  // A closed panel is named by its visible title alone.
  assert.equal(row(closed.id)?.getAttribute('aria-label'), null);
  assert.equal(row(closed.id)?.textContent, title(closed));

  // The same states are visible as words, not only as an icon tint.
  assert.equal(row(docked.id)?.textContent, `${title(docked)}${resolve('shellChrome.activityBar.openHint')}`);
  assert.equal(row(floating.id)?.textContent, `${title(floating)}${resolve('shellChrome.activityBar.floatingHint')}`);
  assert.equal(row(popped.id)?.textContent, `${title(popped)}${resolve('shellChrome.activityBar.poppedHint')}`);

  const target = row(closed.id);
  assert.ok(target);
  click(target);
  assert.deepEqual(selected, [closed.id]);
});

it('keeps More closed until requested and closes it after selection (#8802)', () => {
  const selected: WorkspacePanelId[] = [];
  const container = render(<ActivityBarOverflow ids={['properties', 'compare']}
    locationOf={() => 'closed'} onSelect={(id) => selected.push(id)} />);
  const trigger = container.querySelector<HTMLButtonElement>('[data-rail-overflow]');
  assert.ok(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('[role="menu"]'), null);
  openMenu(trigger);
  const target = document.querySelector<HTMLElement>('[role="menuitem"][data-panel-id="compare"]');
  assert.ok(target);
  click(target);
  assert.deepEqual(selected, ['compare']);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('[role="menu"]'), null);
});
