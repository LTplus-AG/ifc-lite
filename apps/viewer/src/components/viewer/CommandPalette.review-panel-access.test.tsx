/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { buildInitialPresets } from '@/lib/clash/persistence';
import { click, type, waitFor } from '@/test/render';
import { launchDestination, namedButton } from '@/test/palette-destinations';
import { resetReviewAccess, disposeReviewAccess, mountReviewAccess, required,
  dialog, cancelDialog, headerAction, tab, closeBody } from '@/test/palette-review-panel-witness';

// #8947: missing parent joins only. Existing child cases remain in
// inventory/historical-child-bindings.jsonl; this is not a replacement child suite.
beforeEach(resetReviewAccess);
afterEach(disposeReviewAccess);
async function validation() {
  mountReviewAccess();
  await launchDestination('panel:ids', 'ids');
  await waitFor(() => !!document.querySelector('[data-validation-panel]'), 'actual ValidationPanel');
  return required<HTMLElement>('[data-validation-panel]');
}

test('#8947 palette BCF opens its server configuration, gates missing credentials and cancels/reopens', async () => {
  mountReviewAccess(); await launchDestination('panel:bcf', 'bcf');
  await waitFor(() => !!document.querySelector('[data-panel-overflow]'), 'actual BCF header');
  await headerAction('bcf-server');
  assert.ok(required('#bcf-server-url', dialog()));
  assert.ok(required('#bcf-server-user', dialog()));
  assert.ok(required('#bcf-server-password', dialog()));
  assert.equal(namedButton('Connect', dialog()).disabled, true, 'no credentials cannot connect');
  type(required<HTMLInputElement>('#bcf-server-url', dialog()), 'https://example.invalid/bcf');
  assert.equal(namedButton('Connect', dialog()).disabled, true, 'URL alone is insufficient');
  await cancelDialog(); await headerAction('bcf-server');
  assert.ok(required('#bcf-server-url', dialog()), 'same production consumer reopens');
  assert.equal(namedButton('Connect', dialog()).disabled, true);
  await cancelDialog(); assert.equal(useViewerStore.getState().bcfProject, null);
});

test('#8947 palette Data validation reaches actual IDS import/configuration and refuses a run without IFC', async () => {
  let body = await validation();
  click(required('[data-testid="validation-entry-ids"]', body));
  body = required<HTMLElement>('[data-validation-panel]');
  const picker = required<HTMLInputElement>('[data-testid="validation-entry-ids-input"]');
  // Exercise an empty selection; the operating-system file picker is outside this mounted test.
  Object.defineProperty(picker, 'files', { configurable: true, value: [] });
  await act(async () => { picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(useViewerStore.getState().idsDocument, null);
  assert.ok(namedButton('Load IDS file', body));
  const xml = readFileSync(new URL('../../../public/samples/building-architecture.ids', import.meta.url), 'utf8');
  Object.defineProperty(picker, 'files', { configurable: true, value: [new File([xml], 'building-architecture.ids', { type: 'application/xml' })] });
  await act(async () => { picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await waitFor(() => !!document.querySelector('select[aria-label="Select IDS document"]'), 'real imported IDS definition configuration');
  await waitFor(() => !useViewerStore.getState().idsLoading && !useViewerStore.getState().idsAuditing, 'local IDS load and audit settle');
  const title = useViewerStore.getState().idsDocument?.info.title; assert.ok(title);
  assert.ok(body.textContent?.includes(title));
  click(namedButton('Run Validation', body));
  await waitFor(() => /[Ll]oad.*IFC|[Nn]o.*model/.test(body.textContent ?? ''), 'actual missing-model refusal');
  assert.equal(useViewerStore.getState().idsValidationReport, null);
  await closeBody(); await launchDestination('panel:ids', 'ids');
  await waitFor(() => !!document.querySelector('select[aria-label="Select IDS document"]'), 'IDS configuration survives panel reopen');
  assert.ok(document.body.textContent?.includes(title));
});

test('#8947 palette Information validation reaches rule configuration and can close/reopen without running', async () => {
  let body = await validation(); click(namedButton('New rule set', body));
  body = required<HTMLElement>('[data-validation-panel]');
  const name = required<HTMLInputElement>('input[aria-label="Rule set name"]', body);
  type(name, 'Palette review draft');
  assert.ok(body.textContent?.includes('Target models'));
  assert.equal(namedButton('Run', body).disabled, true, 'no rules is a meaningful run prerequisite');
  click(namedButton('Add rule', body));
  assert.ok(required('input[aria-label="Rule name"]', body), 'actual rule configuration opened');
  await closeBody(); await launchDestination('panel:ids', 'ids');
  body = required('[data-validation-panel]');
  const library = required<HTMLSelectElement>('select[aria-label="Select rule set"]', body);
  const saved = [...library.options].find(option => option.textContent === 'Palette review draft');
  assert.ok(saved, 'closed definition remains in actual library');
  act(() => { library.value = saved.value; library.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await waitFor(() => !!document.querySelector('input[aria-label="Rule set name"]'), 'user-selected definition restores actual rule editor');
  assert.equal(required<HTMLInputElement>('input[aria-label="Rule set name"]', body).value, 'Palette review draft');
  assert.equal(useViewerStore.getState().currentValidationReport, null);
});

test('#8947 palette Manual validation opens checklist review and reports the unloaded-model prerequisite', async () => {
  let body = await validation();
  click(namedButton('New checklist', required('[data-testid="validation-entry-manual"]', body)));
  body = required<HTMLElement>('[data-validation-panel]');
  assert.ok(required('input[aria-label="Checklist name"]', body));
  click(namedButton('Done editing', body));
  assert.ok(body.textContent?.includes('Load a model to record verdicts. Answers are stored per model.'));
  assert.ok(namedButton('Edit checklist', body), 'actual manual review face');
  await closeBody(); await launchDestination('panel:ids', 'ids');
  await waitFor(() => !!document.querySelector('input[aria-label="Checklist name"]'), 'actual manual review reopens');
  assert.equal(useViewerStore.getState().models.size, 0);
});

test('#8947 palette Clash opens controlled Detection/Rules settings and cancels/reopens without saving a rule', async () => {
  mountReviewAccess(); await launchDestination('panel:clash', 'clash');
  await waitFor(() => !!document.querySelector('[data-panel-action="clash-settings"], [data-panel-overflow]'), 'actual lazy ClashPanel');
  await headerAction('clash-settings');
  assert.ok(required('input[aria-label="Tolerance"]', dialog()), 'actual Detection settings');
  const presetsBefore = structuredClone(useViewerStore.getState().clashPresets);
  const persistedBefore = structuredClone(buildInitialPresets());
  await tab('Rules', dialog()); click(namedButton('Add rule', dialog()));
  assert.ok(required('input[placeholder="Rule name (e.g. Ducts vs Beams)"]', dialog()));
  assert.equal(namedButton('Add', dialog()).disabled, true, 'empty rule cannot save');
  type(required<HTMLInputElement>('input[placeholder="Rule name (e.g. Ducts vs Beams)"]', dialog()), 'Cancelled palette rule');
  type(required<HTMLInputElement>('input[aria-label="Set A IFC type selector"]', dialog()), 'IfcWall');
  type(required<HTMLInputElement>('input[aria-label="Set B IFC type selector"]', dialog()), 'IfcSlab');
  assert.equal(namedButton('Add', dialog()).disabled, false, 'cancel a valid saveable draft');
  click(required('button[title="Cancel"]', dialog()));
  assert.ok(!dialog().querySelector('input[placeholder="Rule name (e.g. Ducts vs Beams)"]'));
  assert.deepEqual(useViewerStore.getState().clashPresets, presetsBefore);
  assert.deepEqual(buildInitialPresets(), persistedBefore, 'Cancel publishes no durable rule');
  await cancelDialog(); await headerAction('clash-settings');
  assert.ok(required('input[aria-label="Tolerance"]', dialog()));
  await tab('Rules', dialog()); assert.ok(namedButton('Add rule', dialog()));
  assert.deepEqual(useViewerStore.getState().clashPresets, presetsBefore);
  assert.deepEqual(buildInitialPresets(), persistedBefore);
  click(namedButton('Add rule', dialog()));
  assert.equal(required<HTMLInputElement>('input[placeholder="Rule name (e.g. Ducts vs Beams)"]', dialog()).value, '');
  assert.equal(namedButton('Add', dialog()).disabled, true, 'reopened editor has discarded the valid draft');
  click(required('button[title="Cancel"]', dialog()));
  await cancelDialog(); assert.equal(useViewerStore.getState().models.size, 0);
});
