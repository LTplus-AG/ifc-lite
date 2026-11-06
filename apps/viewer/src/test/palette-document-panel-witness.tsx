/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { act, type ReactNode } from 'react';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { seedArtifactModels } from '@/test/artifact-models-fixture';
import { bottomPanelFlags } from '@/lib/panels/bottom-panels';
import { mountDestinations, launchDestination, namedButton } from '@/test/palette-destinations';
import { MobilePanelSheet } from '@/components/viewer/MobilePanelSheet';
import { ConfirmDialogHost } from '@/components/ui/confirm-dialog';
import { click, waitFor } from '@/test/render';

/** Shared real palette + production mobile host, never a surrogate body switch. */
export async function seedPanelWitness() {
  setLocale('en'); localStorage.clear();
  await seedArtifactModels();
  useViewerStore.setState({ ...bottomPanelFlags(null), isMobile: true, loading: false,
    rightPanelCollapsed: true, sidebarActivePanel: 'properties', sidebarMode: 'collapsed',
    floatingPanels: [], poppedOutIds: [], collabRole: null, selectedEntityId: null,
    selectedEntityIds: new Set(), selectedEntity: null, selectedEntitiesSet: new Set(),
    pendingListDraft: null, listDefinitions: [], listResult: null, listError: null,
    listExecuting: false, activeListId: null, savedLenses: [], activeLensId: null });
}
export function mountPanelWitness(extra?: ReactNode) {
  return mountDestinations(<><ConfirmDialogHost />{extra}
    <MobilePanelSheet bottomInset={0} analysisExtension={null} /></>);
}
export function element<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector); assert.ok(found, selector); return found;
}
export async function openPanelWitness(id: 'document' | 'drawing' | 'lists' | 'lens', selector: string) {
  await launchDestination(`panel:${id}`, id);
  await waitFor(() => !!document.querySelector(selector), `palette opens actual ${id} body`);
  assert.equal(document.querySelector('input[role="combobox"]'), null, 'palette closed before child interaction');
  return element(selector);
}
export function choose(selector: string, value: string, root: ParentNode = document) {
  const select = element<HTMLSelectElement>(selector, root);
  assert.ok([...select.options].some(option => option.value === value), `offered option ${value}`);
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  assert.equal(select.value, value);
}
export function openMenu(trigger: Element) {
  act(() => trigger.dispatchEvent(new window.PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, button: 0, pointerType: 'mouse',
  })));
  click(trigger);
}
export function menuItem(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(node => node.textContent?.trim() === label);
  assert.ok(item, label); return item;
}
export function closePanelWitness() {
  // MobileBottomSheet owns the outer close button; no child state injection.
  const resize = element('[role="button"][aria-label="Drag to resize or dismiss"]');
  const sheet = resize.parentElement; assert.ok(sheet);
  click(namedButton('Close', sheet));
  assert.equal(useViewerStore.getState().rightPanelCollapsed, true);
}
