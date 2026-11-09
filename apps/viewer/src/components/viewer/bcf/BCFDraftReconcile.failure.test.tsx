/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A reconcile action that throws is shown in place. On useSingleFlight the
 * throw rejected `run()` unhandled, and the only trace was the global "report
 * this error" invitation; useAsyncRun keeps it in its state, so the panel has
 * to render it or the failure would be invisible.
 */

import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import type { ClashResult } from '@ifc-lite/clash';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { groupOf, proxyWallRun, sampleElements, PROXY_WALL_RULE } from '@/test/bcf-draft-fixture';
import { resolveManualClashGroups } from '@/lib/clash/manual-groups';
import { useClashGroupLibrary } from '@/lib/clash/group-workspace';
import { draftBatchFromGroups } from '@/lib/bcf-drafts/draft-create';
import type { DraftBatch } from '@/lib/bcf-drafts/draft-types';
import { BCFDraftReconcile } from './BCFDraftReconcile';

const initial = useViewerStore.getState();
const initialGroups = useClashGroupLibrary.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(initial, true);
  useClashGroupLibrary.setState(initialGroups, true);
});

/** A drafted batch, and a newer clash run in which one of its topics lost a member. */
async function reconcilable(): Promise<DraftBatch> {
  const { proxies } = await sampleElements();
  const clashes = await proxyWallRun([[0, 1], [1], [2], []]);
  const groups = [groupOf('g-riser', 'Riser through core walls', clashes, [proxies[0].key, proxies[1].key]),
    groupOf('g-east', 'East wall penetration', clashes, [proxies[2].key])];
  const batch = await draftBatchFromGroups('Coordination round 1', 'ws-1', resolveManualClashGroups(groups, clashes),
    { clashes, rules: [PROXY_WALL_RULE.id] });
  const newer = await proxyWallRun([[0, 1], [], [2], []], 'architecture-reloaded');
  const result = { clashes: newer, rulesRun: [PROXY_WALL_RULE] } as unknown as ClashResult;
  useViewerStore.setState({ clashResult: result });
  useClashGroupLibrary.setState({ entries: [{ version: 1, id: 'ws-1', name: 'Workspace', groups }] });
  return batch;
}

const applyButton = (ui: HTMLElement) =>
  [...ui.querySelectorAll('button')].find((node) => node.getAttribute('aria-label')?.startsWith('Apply the proposal to'));
const alertText = (ui: HTMLElement) => ui.querySelector('[role="alert"]')?.textContent ?? null;

test('a throw while applying a reconciliation is shown in the panel, and Apply is usable again', async () => {
  const batch = await reconcilable();
  const warn = console.warn;
  console.warn = () => {};
  try {
    let calls = 0;
    const ui = render(<BCFDraftReconcile batch={batch} onChange={() => { calls++; throw new Error('Saving the batch failed.'); }} />);
    click([...ui.querySelectorAll('button')].find((node) => node.textContent === 'Compare')!);
    const apply = applyButton(ui);
    assert.ok(apply, 'the newer run proposes a change');
    assert.equal(alertText(ui), null);
    click(apply);
    await waitFor(() => alertText(ui) !== null, 'the failure is shown');
    assert.equal(calls, 1);
    assert.equal(alertText(ui), 'The change could not be applied; the batch is unchanged. Saving the batch failed.');
    await act(async () => {});
    assert.equal(applyButton(ui)?.disabled, false, 'a failed run does not leave the panel busy');
  } finally {
    console.warn = warn;
  }
});

test('a successful apply shows no failure', async () => {
  const batch = await reconcilable();
  let applied: DraftBatch | null = null;
  const ui = render(<BCFDraftReconcile batch={batch} onChange={(next) => { applied = next; }} />);
  click([...ui.querySelectorAll('button')].find((node) => node.textContent === 'Compare')!);
  click(applyButton(ui)!);
  await waitFor(() => applied !== null, 'the reconciled batch is handed to the dialog');
  assert.equal(alertText(ui), null);
});
