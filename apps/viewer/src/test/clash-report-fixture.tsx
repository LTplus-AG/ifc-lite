/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drive saved clash reports (#6947) the way a user does: the real Clash panel
 * runs the real detection over real meshes, and a report is saved through the
 * panel's own dialog. Nothing here imports the saved-report modules, so a test
 * built on it fails on an assertion (the dialog is not there) rather than on a
 * module that cannot load when the feature is absent.
 */

import assert from 'node:assert/strict';
import { act } from 'react';
import type { SavedClashReport } from '@/lib/clash/saved-report-schema';
import { ClashPanel } from '@/components/viewer/ClashPanel';
import { useViewerStore } from '@/store';
import { seedCoincidentWalls } from './clash-run-fixture.js';
import { click, render, type, waitFor } from './render.js';

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });

const bodyButton = (name: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === name || button.getAttribute('aria-label') === name);

/** The saved reports as the store holds them; empty when the feature is absent. */
export function savedClashReports(): SavedClashReport[] {
  return (useViewerStore.getState() as { savedClashReports?: SavedClashReport[] }).savedClashReports ?? [];
}

/** Mount the Clash panel once per test; the saved-report dialog and the run buttons live in it. */
export function mountClashPanel(): HTMLElement {
  return render(<ClashPanel />);
}

/** Load `wallCount` coincident walls (every pair clashes) and run "Detect all clashes" through the panel. */
export async function detectCoincidentWalls(wallCount: number, modelCount: 1 | 2 = 1, identity?: (modelId: string) => { sourceFingerprint?: string; sourceContentHash?: string }): Promise<void> {
  await act(async () => {
    await seedCoincidentWalls(modelCount, wallCount);
    if (identity) {
      useViewerStore.setState({ models: new Map([...useViewerStore.getState().models].map(([id, model]) => [id, { ...model, ...identity(id) }])) });
    }
  });
  const before = useViewerStore.getState().clashRunSeq;
  const run = bodyButton('Detect all clashes');
  assert.ok(run, 'the Clash panel offers "Detect all clashes"');
  await act(async () => {
    run.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    // The run waits a frame (bounded by a timer) before scanning.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  await waitFor(() => !useViewerStore.getState().clashRunning && useViewerStore.getState().clashRunSeq > before, 'the clash run completes');
  const pairs = wallCount * (wallCount - 1) / 2;
  assert.equal(useViewerStore.getState().clashResult?.clashes.length, pairs, `${wallCount} coincident walls clash pairwise`);
}

function openSavedReports(): void {
  if (document.body.querySelector('input[aria-label="Report name"]')) return;
  const trigger = bodyButton('Saved clash reports');
  assert.ok(trigger, 'the Clash panel header offers saved clash reports (#6947)');
  click(trigger);
}

/** Save the current result under `name` through the dialog and wait for the durable write. */
export async function saveCurrentResultAs(name: string): Promise<SavedClashReport> {
  openSavedReports();
  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Report name"]');
  assert.ok(input, 'the saved-report dialog has a name field');
  type(input, name);
  const save = bodyButton('Save current result');
  assert.ok(save && !save.disabled, 'the current result can be saved');
  click(save);
  await waitFor(() => {
    const report = savedClashReports().find((entry) => entry.name === name);
    return !!report && useViewerStore.getState().savedClashReportsStorage.items[report.id] === 'saved';
  }, `the report "${name}" is written to the saved content library`);
  const report = savedClashReports().find((entry) => entry.name === name);
  assert.ok(report);
  return report;
}

/** Delete a saved report through the dialog: Delete, then the confirmation. */
export async function deleteSavedReport(report: SavedClashReport): Promise<void> {
  openSavedReports();
  const row = document.body.querySelector(`[data-clash-report="${report.id}"]`);
  assert.ok(row, `the dialog lists "${report.name}"`);
  const remove = [...row.querySelectorAll('button')].find((button) => button.textContent === 'Delete');
  assert.ok(remove);
  click(remove);
  assert.match(row.textContent ?? '', /will show it as unavailable/, 'deleting warns that bound charts lose their source');
  const confirm = [...row.querySelectorAll('button')].find((button) => button.textContent === 'Delete report');
  assert.ok(confirm);
  click(confirm);
  await waitFor(() => !savedClashReports().some((entry) => entry.id === report.id)
    && useViewerStore.getState().savedClashReportsStorage.items[report.id] === 'saved', 'the deletion is written');
}
