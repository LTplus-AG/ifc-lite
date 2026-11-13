/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, type as enterText } from '@/test/render';
import { useViewerStore } from '@/store';
import { SettingsDialogHost } from './settings/SettingsDialog';
import { SearchModal } from './SearchModal';
import { useMeasurementDestination } from '@/lib/panels/measurement-destination';
import { GEOM_WORKERS_STORAGE_KEY } from '@/store/geomWorkerOverride';
import { mountDestinations, launchDestination, namedButton } from '@/test/palette-destinations';
import { setLocale } from '@/i18n';

const initial = useViewerStore.getState();
const hosts: ReturnType<typeof mountDestinations>[] = [];
beforeEach(() => {
  setLocale('en'); localStorage.clear();
  useViewerStore.setState({ models: new Map(), geometryResult: null, ifcDataStore: null, loading: false,
    selectedEntityId: null, selectedEntityIds: new Set(), collabRole: null });
});
afterEach(async () => {
  cleanup(); for (const host of hosts.splice(0)) await host.dispose();
  useViewerStore.setState(initial); useMeasurementDestination.setState({ tab: 'list', revision: 0 }); localStorage.clear();
});
function mount() { hosts.push(mountDestinations(<SettingsDialogHost />)); }
function dialog() {
  const node = document.querySelector<HTMLElement>('[data-settings-dialog]'); assert.ok(node); return node;
}
for (const [section, label, query] of [
  ['general', 'General', 'hover helpers'], ['display', 'Display', 'SpaceMouse'],
  ['performance', 'Performance', 'worker overrides'], ['collaboration', 'Collaboration', 'display name'],
  ['privacy', 'Privacy', 'action log'],
] as const) test(`#8947 unloaded Settings ${section} reveals its actual body and repeated section request`, async () => {
  mount();
  await launchDestination(`settings:${section}`, query);
  assert.match(dialog().querySelector('[role="tab"][data-state="active"]')?.textContent ?? '', new RegExp(label.split(' &')[0]));
  const other = [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')].find(t => t.textContent === (section === 'general' ? 'Privacy' : 'General'));
  assert.ok(other); click(other);
  await launchDestination(`settings:${section}`, query);
  assert.match(dialog().querySelector('[role="tabpanel"][data-state="active"]')?.textContent ?? '', section === 'display' ? /SpaceMouse/ : section === 'privacy' ? /Action log/ : section === 'collaboration' ? /Display name/ : section === 'performance' ? /overrides/i : /Theme/);
});
test('#8947 Settings destinations expose navigation, helpers, override reset and saved identity actions', async () => {
  localStorage.setItem(GEOM_WORKERS_STORAGE_KEY, '4'); mount();
  await launchDestination('settings:general', 'helpers');
  const helper = dialog().querySelector('#settings-hover-tooltips'); assert.ok(helper);
  const before = useViewerStore.getState().hoverTooltipsEnabled; click(helper);
  assert.equal(useViewerStore.getState().hoverTooltipsEnabled, !before);
  await launchDestination('settings:display', 'navigation preset');
  const trackpad = [...dialog().querySelectorAll('label')].find(l => l.textContent === 'Trackpad')?.querySelector('input'); assert.ok(trackpad); click(trackpad);
  assert.equal(useViewerStore.getState().navigationPreset, 'trackpad');
  await launchDestination('settings:performance', 'worker overrides');
  click(namedButton('Reset Geometry workers', dialog()));
  assert.equal(localStorage.getItem(GEOM_WORKERS_STORAGE_KEY), null);
  await launchDestination('settings:collaboration', 'display name');
  const input = dialog().querySelector<HTMLInputElement>('#settings-collab-name'); assert.ok(input);
  enterText(input, '  Palette reviewer  '); click(dialog().querySelector('button[type="submit"]')!);
  assert.equal(useViewerStore.getState().collabIdentity.name, 'Palette reviewer');
  await launchDestination('settings:privacy', 'action log');
  const analytics = dialog().querySelector('#settings-analytics-opt-out'); assert.ok(analytics);
  const checked = analytics.getAttribute('aria-checked'); click(analytics);
  assert.notEqual(analytics.getAttribute('aria-checked'), checked);
});
for (const tab of ['filter', 'libraries'] as const) test(`#8947 unloaded Search ${tab} opens the named tab again after user switches`, async () => {
  hosts.push(mountDestinations(<SearchModal />));
  for (let i = 0; i < 2; i++) {
    await launchDestination(`search:${tab}`, tab === 'filter' ? 'rules groups' : 'native libraries');
    const active = document.querySelector('[role="tab"][data-state="active"]');
    assert.equal(active?.textContent, tab === 'filter' ? 'Filter' : 'Libraries');
    assert.ok(document.querySelector('[role="tabpanel"][data-state="active"]'));
    act(() => { useViewerStore.getState().setSearchModalTab('search'); useViewerStore.getState().setSearchModalOpen(false); });
  }
});
