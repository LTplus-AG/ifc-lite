/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import assert from 'node:assert/strict';
import { createBimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { LocalBackend } from '@/sdk/local-backend';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { fixtureModels } from '@/test/store-fixture';
import { cleanup, click, press, render, waitFor } from '@/test/render';
import { namedButton } from '@/test/palette-destinations';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { CommandPalette } from '@/components/viewer/CommandPalette';
import { PersistentToolHosts } from '@/components/viewer/PersistentToolHosts';
import { MobilePanelSheet } from '@/components/viewer/MobilePanelSheet';

const initial = useViewerStore.getState();
const originalFetch = globalThis.fetch;
let host: ExtensionHostService | undefined;
let networkAttempts: string[] = [];

export function resetReviewAccess() {
  setLocale('en'); localStorage.clear(); networkAttempts = [];
  globalThis.fetch = (input) => {
    networkAttempts.push(String(input));
    return Promise.reject(new Error('Network forbidden in palette access witness'));
  };
  useViewerStore.setState({ ...initial, ...fixtureModels(), ifcDataStore: null,
    isMobile: true, loading: false, rightPanelCollapsed: true, sidebarActivePanel: 'properties',
    floatingPanels: [], poppedOutIds: [], bcfProject: null, bcfError: null, bcfLoading: false,
    idsDocument: null, idsAuditReport: null, idsValidationReport: null,
    currentValidationReport: null, validationSource: null, idsLoading: false, idsAuditing: false,
    idsError: null, savedValidationReports: [], sourceTags: new Map(),
  });
  useViewerStore.getState().clearValidationRuleSetDraft();
  setValidationSourceChoice(null);
}
export async function disposeReviewAccess() {
  cleanup();
  try { await host?.dispose(); }
  finally {
    host = undefined; globalThis.fetch = originalFetch;
    useViewerStore.setState(initial, true); setValidationSourceChoice(null); localStorage.clear();
  }
  assert.deepEqual(networkAttempts, [], 'opening/configuring/cancelling never requests a service');
}

/** Same palette launcher contract as palette-destinations, with the real local backend.
 * Actual mobile host owns routing and renderPanelBody; no panel surrogate is mounted. */
export function mountReviewAccess() {
  const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
  host = new ExtensionHostService({ sdk: bim });
  function Harness() {
    const [open, setOpen] = useState(false);
    return <BimReactContext.Provider value={bim}><ExtensionHostContext.Provider value={host!}>
      <SourceHostProvider><PersistentToolHosts>
        <button data-palette-launcher onClick={() => setOpen(true)}>Commands</button>
        <CommandPalette open={open} onOpenChange={setOpen} />
        <MobilePanelSheet bottomInset={0} analysisExtension={null} />
      </PersistentToolHosts></SourceHostProvider>
    </ExtensionHostContext.Provider></BimReactContext.Provider>;
  }
  render(<Harness />);
}
export function required<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(selector); assert.ok(node, selector); return node;
}
export function dialog() { return required<HTMLElement>('[role="dialog"]'); }
export async function cancelDialog() {
  click(namedButton('Close', dialog()));
  await waitFor(() => !document.querySelector('[role="dialog"]'), 'actual controlled dialog closes');
}
export async function headerAction(id: string) {
  const selector = `[data-panel-action="${id}"]`;
  if (!document.querySelector(selector)) {
    press(required('[data-panel-overflow]'), 'ArrowDown');
    await waitFor(() => !!document.querySelector(selector), 'header overflow exposes action');
  }
  const action = required(selector);
  if (action.getAttribute('role')?.startsWith('menuitem')) press(action, 'Enter');
  else click(action);
  await waitFor(() => !!document.querySelector('[role="dialog"]'), 'real panel opens controlled dialog');
}
export async function tab(label: string, root: ParentNode = document) {
  const trigger = [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find(node => node.textContent?.trim() === label);
  assert.ok(trigger, label); press(trigger, 'Enter');
  await waitFor(() => trigger.getAttribute('aria-selected') === 'true', `${label} selected`);
}
export async function closeBody() {
  click(required('[data-panel-close]'));
  await waitFor(() => !document.querySelector('[data-validation-panel]'), 'validation body unmounted');
}
