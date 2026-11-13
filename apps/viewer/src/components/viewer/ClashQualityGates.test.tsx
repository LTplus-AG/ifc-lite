/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createClashEngine, type ClashElement } from '@ifc-lite/clash';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { cleanup, click, render, type, waitFor } from '@/test/render';
import { mountClashPanel, detectCoincidentWalls, saveCurrentResultAs } from '@/test/clash-report-fixture';
import { useViewerStore } from '@/store';
import { defaultQualityGateConfig } from '@/lib/clash/quality-gate';
import { runRequestOf } from '@/lib/clash/run-request';
import { useQualityGatePreferences, loadQualityGateConfig } from '@/lib/clash/quality-gate-preferences';
import { ClashQualityGates } from './ClashQualityGates';

afterEach(() => { cleanup(); useQualityGatePreferences.setState({ config: defaultQualityGateConfig() }); });

describe('Quality gate interaction (#9259)', () => {
  it('publishes duplicate run metadata before subscribers and saves the duplicate policy (#9430)', async () => {
    const config = defaultQualityGateConfig();
    config.clash[0].label = 'Clash benchmark';
    config.duplicates[0].label = 'Duplicate benchmark';
    useQualityGatePreferences.setState({ config });
    const ui = mountClashPanel();
    await detectCoincidentWalls(3);
    const button = (name: RegExp) => [...ui.querySelectorAll('button')].find(item => name.test(item.textContent?.trim() ?? ''));
    if (!button(/^Find duplicates$/)) {
      const detection = button(/^Detection/);
      assert.ok(detection);
      click(detection);
    }
    const duplicates = button(/^Find duplicates$/);
    assert.ok(duplicates, 'the panel offers the real duplicate scan');
    const publications: Array<string | undefined> = [];
    const unsubscribe = useViewerStore.subscribe((state, previous) => {
      if (state.clashRawResult && state.clashRawResult !== previous.clashRawResult) {
        publications.push(runRequestOf(state.clashRawResult)?.kind);
      }
    });
    const before = useViewerStore.getState().clashRunSeq;
    try {
      await act(async () => {
        duplicates.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 300));
      });
      await waitFor(() => !useViewerStore.getState().clashRunning && useViewerStore.getState().clashRunSeq > before, 'duplicate detection completes');
    } finally {
      unsubscribe();
    }
    assert.deepEqual(publications, ['duplicates']);
    assert.match(ui.querySelector('[data-quality-rule]')?.textContent ?? '', /Duplicate benchmark/);
    const saved = await saveCurrentResultAs('Duplicate policy #9430');
    assert.equal(saved.run.kind, 'duplicates');
    assert.equal(saved.qualityGates?.rows[0].kind, 'duplicates');
    assert.equal(saved.qualityGates?.config.duplicates[0].label, 'Duplicate benchmark');
  });
  it('shows actual detection object counts and saves frozen categories, for one and multiple models', async () => {
    for (const count of [1, 2] as const) {
      const ui = mountClashPanel();
      await detectCoincidentWalls(3, count);
      const card = ui.querySelector('[data-quality-rule]');
      assert.ok(card, 'a completed detection renders the gate at the top of Clash');
      assert.match(card.textContent ?? '', /3 checked · 3 affected/);
      assert.match(card.textContent ?? '', /0.0%/);
      assert.match(card.textContent ?? '', /Failed/);
      const configAtCapture = useQualityGatePreferences.getState().config;
      const saved = await saveCurrentResultAs(`Gate ${count}`);
      assert.equal(saved.qualityGates?.rows[0].checked, 3);
      assert.equal(saved.qualityGates?.rows[0].affected, 3);
      act(() => {
        configAtCapture.clash[0].label = 'New label';
        useQualityGatePreferences.setState({ config: structuredClone(configAtCapture) });
      });
      assert.equal(saved.qualityGates?.config.clash[0].label, 'Failed');
      cleanup();
      useQualityGatePreferences.setState({ config: defaultQualityGateConfig() });
    }
  });
  it('edits separate clash/duplicate categories through controls and persists only valid ranges', () => {
    const ui = render(<ClashQualityGates />);
    const detail = ui.querySelector('details');
    assert.ok(detail);
    act(() => { detail.open = true; });
    const label = ui.querySelector<HTMLInputElement>('input[aria-label="Clash checks Category name 1"]');
    const minimum = ui.querySelector<HTMLInputElement>('input[aria-label="Clash checks Minimum clean objects % 2"]');
    assert.ok(label && minimum);
    type(label, 'Needs coordination');
    const save = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Save thresholds');
    assert.ok(save);
    type(minimum, '0');
    assert.ok(save.disabled, 'overlapping category boundaries cannot be committed');
    type(minimum, '90');
    click(save);
    assert.equal(loadQualityGateConfig().clash[0].label, 'Needs coordination');
    assert.equal(loadQualityGateConfig().duplicates[0].label, 'Failed');
  });
  it('suppresses a previous passing gate when models change after a run', async () => {
    const element = (ref: number, x: number): ClashElement => ({
      key: `clean-${ref}`, ref, model: 'A', tag: 'IfcWall',
      positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]), indices: new Uint32Array([0, 1, 2]),
      bounds: { min: [x, 0, 0], max: [x + 1, 1, 0] },
    });
    const result = await createClashEngine({ backend: 'ts' }).run([element(1, 0), element(2, 10)],
      [{ id: 'clean', name: 'Separated walls', a: 'IfcWall', mode: 'hard' }]);
    stampAnalysisReport(result, captureAnalysisStamp());
    act(() => useViewerStore.getState().setClashResult(result));
    const ui = render(<ClashQualityGates />);
    assert.match(ui.querySelector('[data-quality-rule]')?.textContent ?? '', /100.0%/);
    assert.match(ui.querySelector('[data-quality-rule]')?.textContent ?? '', /Passed/);
    act(() => useViewerStore.setState(state => ({ mutationVersion: state.mutationVersion + 1 })));
    const card = ui.querySelector('[data-quality-rule]');
    assert.ok(card);
    assert.match(card.textContent ?? '', /Outdated run/);
    assert.doesNotMatch(card.textContent ?? '', /Passed|100.0%/);
  });
});
