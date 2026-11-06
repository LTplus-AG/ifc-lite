/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { installLayout } from '@/test/dom-layout';
installLayout();
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Camera } from '@ifc-lite/renderer';
import { cleanup, click, advance } from '@/test/render';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { useViewerStore } from '@/store';
import { setLocale } from '@/i18n';
import { mountDestinations, launchDestination, searchDestination, destinationOption, namedButton } from '@/test/palette-destinations';
import { KeyboardShortcutsDialog, useKeyboardShortcutsDialog } from './KeyboardShortcutsDialog';

const initial = useViewerStore.getState();
const hosts: ReturnType<typeof mountDestinations>[] = [];
beforeEach(async () => { setLocale('en'); localStorage.clear(); await seedModelingSession(); });
afterEach(async () => {
  cleanup(); for (const host of hosts.splice(0)) await host.dispose();
  mock.restoreAll(); useViewerStore.setState(initial); localStorage.clear();
});

for (const [name, direction] of [
  ['front-top', { x: 0, y: 1, z: 1 }],
  ['back-left-bottom', { x: -1, y: -1, z: -1 }],
] as const) test(`#8947 palette ${name} preset reaches the real renderer camera`, async () => {
  const camera = new Camera();
  const bounds = { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 10, z: 5 } };
  let now = 1_000;
  mock.method(Date, 'now', () => now);
  useViewerStore.setState({ cameraCallbacks: {
    setPresetDirection: value => camera.setPresetDirection(value, bounds),
  } });
  hosts.push(mountDestinations(null));
  await launchDestination(`view:orientation:${name}`, name.replaceAll('-', ' '));
  now += 400; camera.update(0);
  const p = camera.getPosition(), t = camera.getTarget();
  const actual = { x: p.x - t.x, y: p.y - t.y, z: p.z - t.z };
  const length = Math.hypot(actual.x, actual.y, actual.z);
  const expectedLength = Math.hypot(direction.x, direction.y, direction.z);
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.ok(Math.abs(actual[axis] / length - direction[axis] / expectedLength) < 1e-6);
  }
  assert.deepEqual(t, { x: 0, y: 5, z: 0 });
});

test('#8947 edge presets explain missing model and camera, then recover while palette stays open', async () => {
  const models = useViewerStore.getState().models;
  const data = useViewerStore.getState().ifcDataStore;
  useViewerStore.setState({ models: new Map(), ifcDataStore: null, geometryResult: null, cameraCallbacks: {} });
  hosts.push(mountDestinations(null)); searchDestination('front top');
  const id = 'view:orientation:front-top';
  assert.equal(destinationOption(id).getAttribute('aria-disabled'), 'true');
  assert.match(destinationOption(id).textContent ?? '', /model/i);
  act(() => useViewerStore.setState({ models, ifcDataStore: data }));
  assert.equal(destinationOption(id).getAttribute('aria-disabled'), 'true');
  assert.match(destinationOption(id).textContent ?? '', /camera/i);
  const camera = new Camera();
  act(() => useViewerStore.setState({ cameraCallbacks: {
    setPresetDirection: value => camera.setPresetDirection(value, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }),
  } }));
  assert.notEqual(destinationOption(id).getAttribute('aria-disabled'), 'true');
  click(destinationOption(id)); await advance(60);
  assert.equal(document.querySelector('[role="combobox"]'), null);
});

function InfoHost() {
  const dialog = useKeyboardShortcutsDialog();
  return <KeyboardShortcutsDialog open={dialog.open} onClose={dialog.close} initialTab={dialog.tab} />;
}
for (const [id, query, label] of [['about', 'about', 'About'], ['whatsnew', 'release notes', "What's New"], ['shortcuts', 'keyboard shortcuts', 'Shortcuts']] as const)
  test(`#8947 ${id} destination reaches its actual help tab repeatedly`, async () => {
    hosts.push(mountDestinations(<InfoHost />));
    for (let pass = 0; pass < 2; pass++) {
      await launchDestination(`learn:${id}`, query);
      assert.equal(document.querySelector('[role="tab"][data-state="active"]')?.textContent?.trim(), label);
      assert.ok(document.querySelector('[role="tabpanel"][data-state="active"]'));
      const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
      click(namedButton('Close', dialog)); await advance(30);
    }
  });
