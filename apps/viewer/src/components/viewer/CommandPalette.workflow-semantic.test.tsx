/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { cleanup, click, type, waitFor } from '@/test/render';
import { fixtureModels } from '@/test/store-fixture';
import { seedSemanticModels } from '@/test/semantic-model-fixture';
import { mountDestinations, launchDestination, namedButton } from '@/test/palette-destinations';
import { MobilePanelSheet } from './MobilePanelSheet';
import { useSemanticSession } from '@/lib/semantic/session';
import { revokeEndpointGrant } from '@/lib/semantic/assist/endpoint-grant';
import { useSemanticSourceTexts } from '@/lib/semantic/assist/source-texts';

const originalFetch = globalThis.fetch;
const initial = useViewerStore.getState();
const session = useSemanticSession.getState();
let host: ReturnType<typeof mountDestinations> | undefined;
beforeEach(() => {
  setLocale('en'); localStorage.clear();
  globalThis.fetch = (() => Promise.reject(new Error('External network disabled in palette workflow witness'))) as typeof fetch;
  useViewerStore.setState({ ...fixtureModels(), ifcDataStore: null, isMobile: true, loading: false,
    rightPanelCollapsed: true, sidebarActivePanel: 'properties', floatingPanels: [], poppedOutIds: [],
    scriptPanelVisible: false, listPanelVisible: false, editEnabled: true, collabRole: null,
    mutationViews: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map() });
});
afterEach(async () => {
  cleanup(); globalThis.fetch = originalFetch; mock.restoreAll(); revokeEndpointGrant(); await host?.dispose(); host = undefined;
  useSemanticSourceTexts.setState({ sources: [] }); useViewerStore.setState(initial, true);
  useSemanticSession.setState(session, true); localStorage.clear();
});
function panel() {
  const node = document.querySelector<HTMLElement>('section[aria-label="Linked records"]');
  assert.ok(node); return node;
}
function disclosure(text: string) {
  const summary = [...panel().querySelectorAll('summary')].find(s => s.textContent === text);
  assert.ok(summary, text); click(summary); return summary.parentElement!;
}
function change(select: HTMLSelectElement, value: string) {
  act(() => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
}
async function openSemantic() {
  host = mountDestinations(<MobilePanelSheet bottomInset={0} analysisExtension={null} />);
  await launchDestination('panel:semantic', 'linked records');
  await waitFor(() => !!document.querySelector('section[aria-label="Linked records"]'), 'canonical linked-records body');
  assert.equal(document.querySelector('input[role="combobox"]'), null);
}

test('#8947 unloaded palette Linked records rejects malformed identity links, applies a valid mapping and clears it', async () => {
  await openSemantic();
  const identity = panel().querySelector<HTMLSelectElement>('select[aria-label]'); assert.ok(identity);
  // The select is owned by the real identity disclosure, not a surrogate panel.
  const details = identity.closest('details'); assert.ok(details);
  click(details.querySelector('summary')!);
  change(identity, 'resource-links');
  const links = details.querySelector('textarea'); assert.ok(links);
  type(links, '[{"resourceId":"broken"}]');
  click(namedButton('Apply resource links', details));
  await waitFor(() => /Links require/.test(panel().querySelector('[role="alert"]')?.textContent ?? ''), 'identity refusal');
  assert.deepEqual(useSemanticSession.getState().links, []);
  const mapping = [{ resourceId: 'https://example.org/palette/resource',
    modelRevision: 'https://example.org/palette/revision', GlobalId: '0000000000000000000001' }];
  type(links, JSON.stringify(mapping)); click(namedButton('Apply resource links', details));
  assert.deepEqual(useSemanticSession.getState().links, mapping, 'valid input reaches the canonical identity configuration');
  type(links, '[]'); click(namedButton('Apply resource links', details));
  assert.deepEqual(useSemanticSession.getState().links, [], 'empty input clears an actually populated mapping');
  change(identity, 'profile-fields');
  assert.equal(details.querySelectorAll('select').length, 3, 'profile identity offers GlobalId and revision field choices');
  change(identity, 'ifc-global-id');
  assert.equal(details.querySelector('textarea'), null, 'returning to direct identity removes link draft controls');
  assert.equal(useViewerStore.getState().models.size, 0, 'configuration never fabricates loaded IFC models');
});

test('#8947 loaded palette Linked records selects a federated record, previews projection and restores a saved workspace', async () => {
  const seeded = await seedSemanticModels(2);
  await openSemantic();
  const record = [...panel().querySelectorAll('button')].find(b => b.textContent?.includes('Installed door') && !b.disabled);
  assert.ok(record, 'actual pilot record row'); click(record);
  assert.equal(useViewerStore.getState().selectedEntity?.modelId, 'm0');
  assert.equal(useViewerStore.getState().selectedEntity?.expressId, seeded.authored.doors[0]);
  // Preview is deliberately the review boundary: this witness does not apply IFC edits.
  const preview = namedButton('Preview projection', panel()); assert.equal(preview.disabled, false);
  const before = useViewerStore.getState().mutationVersion;
  click(preview);
  assert.ok(namedButton('Apply reviewed projection', panel()));
  assert.match([...panel().querySelectorAll('pre')].at(-1)?.textContent ?? '', /FireRating/);
  assert.equal(useViewerStore.getState().mutationVersion, before, 'review does not mutate IFC');
  const policyLabel = [...panel().querySelectorAll('label')].find(label => label.textContent?.startsWith('Existing property conflict policy'));
  const policy = policyLabel?.querySelector('select'); assert.ok(policy); change(policy, 'skip');
  assert.equal([...panel().querySelectorAll('button')].some(b => b.textContent === 'Apply reviewed projection'), false, 'changing review policy invalidates preview');
  click(preview); assert.match([...panel().querySelectorAll('pre')].at(-1)?.textContent ?? '', /"policy": "skip"/);
  const workspace = disclosure('Portable workspace');
  const downloads: Blob[] = [];
  mock.method(URL, 'createObjectURL', (blob: Blob | MediaSource) => { assert.ok(blob instanceof Blob); downloads.push(blob); return 'blob:palette-semantic'; });
  mock.method(HTMLAnchorElement.prototype, 'click', () => {});
  click(namedButton('Save and download workspace', workspace));
  assert.equal(downloads.length, 1);
  const serialized = await downloads[0].text(); assert.ok(serialized.includes('workspace'));
  click(namedButton('Restore saved workspace', workspace));
  assert.equal(useSemanticSession.getState().revisions.size, 0, 'restore requires explicit reassociation to live models');
  assert.ok(useSemanticSession.getState().pendingRevisions.length > 0);
  assert.equal(namedButton('Preview projection', panel()).disabled, true, 'unscoped restored record cannot edit IFC');
  assert.equal(useViewerStore.getState().mutationVersion, before);
});
