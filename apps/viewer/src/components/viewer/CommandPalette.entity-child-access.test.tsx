/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { MODEL_ID, MESH_WALL, seedModelingSession } from '@/test/modeling-session-fixture';
import { cleanup, click, press, render, type as typeInto, waitFor } from '@/test/render';
import { getLocale, setLocale } from '@/i18n';
import { resolveEnglish } from '@/i18n/registry';
import { CommandPalette } from './CommandPalette';
import { EntityContextMenu } from './EntityContextMenu';
import { AnonymizedExportDialog } from './anonymized-export/AnonymizedExportDialog';

// #8947: hand-authored IFC parsed by the real parser; no authoring-tool/GPU claim.
const initial = useViewerStore.getState();
const locale = getLocale();
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalAnchorClick = HTMLAnchorElement.prototype.click;
let publications: number;
const sdk = createBimContext({ backend: new LocalBackend(useViewerStore) });
let copied: string[];
beforeEach(async () => {
  setLocale('en'); localStorage.clear();
  await seedModelingSession();
  useViewerStore.setState({ collabRole: null, canCollabEdit: () => true,
    selectedEntityId: null, selectedEntityIds: new Set(), selectedEntity: null,
    hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null,
    anonymizedExportRequested: false,
    contextMenu: { isOpen: false, entityId: null, screenX: 0, screenY: 0 } });
  copied = []; publications = 0;
  HTMLAnchorElement.prototype.click = () => { publications++; };
  // Intercept only the browser clipboard boundary, not entity resolution.
  Object.defineProperty(navigator, 'clipboard', { configurable: true,
    value: { writeText: async (value: string) => { copied.push(value); } } });
});
afterEach(() => {
  HTMLAnchorElement.prototype.click = originalAnchorClick;
  cleanup(); useViewerStore.setState(initial, true); setLocale(locale); localStorage.clear();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
});
function Harness() {
  const [open, setOpen] = useState(false);
  return <BimReactContext.Provider value={sdk}>
    <button onClick={() => setOpen(true)}>Commands</button>
    <CommandPalette open={open} onOpenChange={setOpen} />
    <EntityContextMenu />
    <AnonymizedExportDialog surface="context_menu" />
  </BimReactContext.Provider>;
}
function seedTarget(federated: boolean) {
  if (federated) {
    const model = useViewerStore.getState().models.get(MODEL_ID)!;
    useViewerStore.setState({ models: new Map([
      [MODEL_ID, { ...model, idOffset: 1_000_000 }],
      ['other', { ...model, id: 'other', idOffset: 2_000_000 }],
    ]) });
  }
  const state = useViewerStore.getState();
  const target = toGlobalIdFromModels(state.models, MODEL_ID, MESH_WALL);
  assert.equal(target, federated ? 1_000_130 : 130);
  state.setSelectedEntityId(target);
  state.setSelectedEntityIds([target]);
  return target;
}
async function openChild(id: string) {
  const ui = render(<Harness />);
  const launcher = ui.querySelector<HTMLButtonElement>('button')!;
  launcher.focus(); click(launcher);
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]');
  assert.ok(input);
  typeInto(input, 'Selected entity actions');
  const row = document.querySelector('[role="option"][data-command-id="elements:entity-actions"]');
  assert.ok(row);
  assert.equal(row.getAttribute('aria-selected'), 'true');
  assert.notEqual(row.getAttribute('aria-disabled'), 'true');
  press(input, 'Enter');
  await waitFor(() => document.querySelector('[role="menu"]')?.contains(document.activeElement) === true,
    'canonical entity menu receives focus after palette activation');
  const menu = document.querySelector('[role="menu"]')!;
  const child = menu.querySelector<HTMLElement>(`[data-command-id="${id}"]`);
  assert.ok(child, id);
  assert.notEqual(child.getAttribute('aria-disabled'), 'true');
  assert.equal(document.querySelector('input[role="combobox"]'), null);
  return { child, launcher };
}
async function expectFocus(launcher: HTMLButtonElement) {
  await waitFor(() => !useViewerStore.getState().contextMenu.isOpen && document.activeElement === launcher,
    'closing the canonical entity menu restores its actual palette launcher');
}

for (const federated of [false, true]) {
  const mode = federated ? 'federated' : 'single';
  test(`#8947 palette entity child copies actual IFC GlobalId (${mode})`, async () => {
    const target = seedTarget(federated);
    const { child, launcher } = await openChild('context:copy-global-id');
    assert.equal(useViewerStore.getState().contextMenu.entityId, target);
    click(child);
    assert.deepEqual(copied, ['3wdauVJT5Fx9drrREiDqA$'], 'clipboard receives IFC identity, not renderer/express ID');
    await expectFocus(launcher);
  });

  test(`#8947 palette same-storey child selects exact parsed fixture members (${mode})`, async () => {
    const target = seedTarget(federated);
    const { child, launcher } = await openChild('context:select-same-storey');
    assert.equal(useViewerStore.getState().contextMenu.entityId, target);
    click(child);
    // IFC #71 contains exactly #80, #100, #120, #130 in #40. This is an
    // independent fixture oracle, not a call to the selection implementation.
    assert.deepEqual([...useViewerStore.getState().selectedEntityIds].sort((a, b) => a - b),
      federated ? [1_000_080, 1_000_100, 1_000_120, 1_000_130] : [80, 100, 120, 130]);
    await expectFocus(launcher);
  });

  test(`#8947 palette anonymized entity child reaches real subset options and cancels (${mode})`, async () => {
    const target = seedTarget(federated);
    const before = useViewerStore.getState();
    const prior = { hidden: new Set(before.hiddenEntities), isolated: before.isolatedEntities,
      ghost: before.ghostExceptEntities, selected: new Set(before.selectedEntityIds), scalar: before.selectedEntityId };
    const { child } = await openChild('context:export-anonymized');
    assert.equal(useViewerStore.getState().contextMenu.entityId, target);
    click(child);
    await waitFor(() => document.querySelector('#anon-toggle-names') !== null,
      'context child opens the real trigger-less anonymized host and its options');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]'); assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /mesh wall/);
    const seed = [...dialog.querySelectorAll('label')].find(label => label.textContent?.trim() === 'IfcWall mesh wall');
    assert.ok(seed, 'review identifies the actual selected source entity');
    const seedCheckbox = seed.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(seedCheckbox);
    assert.equal(seedCheckbox.checked, true); assert.equal(seedCheckbox.disabled, true);
    const names = dialog.querySelector<HTMLElement>('#anon-toggle-names'); assert.ok(names);
    assert.equal(names.getAttribute('aria-checked'), 'true');
    click(names); assert.equal(names.getAttribute('aria-checked'), 'false');
    const psets = dialog.querySelector<HTMLElement>('#anon-toggle-propertySets'); assert.ok(psets);
    click(psets); assert.equal(psets.getAttribute('aria-checked'), 'false');
    assert.ok(useViewerStore.getState().isolatedEntities?.has(target), 'preview retains the qualified seed');
    if (federated) assert.ok([...useViewerStore.getState().isolatedEntities ?? []].every(id => id < 2_000_000),
      'review never expands into the second model');
    const cancel = [...dialog.querySelectorAll('button')].find(button =>
      button.textContent?.trim() === resolveEnglish('anonymizedExport.dialog.cancelButton'));
    assert.ok(cancel); click(cancel);
    await waitFor(() => !document.querySelector('#anon-toggle-names'), 'Cancel closes the real subset review');
    const after = useViewerStore.getState();
    assert.equal(after.anonymizedExportRequested, false);
    assert.deepEqual(after.hiddenEntities, prior.hidden);
    assert.deepEqual(after.isolatedEntities, prior.isolated);
    assert.deepEqual(after.ghostExceptEntities, prior.ghost);
    assert.deepEqual(after.selectedEntityIds, prior.selected);
    assert.equal(after.selectedEntityId, prior.scalar);
    assert.deepEqual(copied, []);
    assert.equal(publications, 0, 'review cancellation never publishes an export');
  });
}
