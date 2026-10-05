/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared result chrome (U02, #6925), mounted: the ResultView regions,
 * status chips that never rely on colour alone, empty-state kinds, the scope
 * control, "select all" that names its population and a scoped action that
 * waits for the authoritative keys.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useCallback, useRef } from 'react';
import { act } from 'react';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { ResultCoverage, ResultSource, ResultView } from './ResultView';
import { StatusChip, type ResultStatus } from './StatusChip';
import { ResultState, type ResultStateKind } from './ResultState';
import { ScopeControl } from './ScopeControl';
import { SelectAllControl } from './SelectAllControl';
import { ResultAction, SelectionSummary } from './ResultAction';
import { useResultSelection } from './useResultSelection';
import { ArtifactHeader } from './ArtifactHeader';

afterEach(cleanup);

const text = (root: ParentNode) => root.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const button = (root: ParentNode, label: RegExp) =>
  [...root.querySelectorAll('button')].find((candidate) => label.test(candidate.textContent ?? ''));

const STATUSES: ResultStatus[] = [
  'complete', 'partial', 'failed', 'running', 'stale', 'cancelled', 'interrupted', 'queued', 'uncertain', 'blocked',
  'unsupported', 'draft', 'ready', 'applying', 'applied',
];

describe('shared result chrome (U02, #6925)', () => {
  it('renders the regions in one order inside a named region', () => {
    const ui = render(
      <ResultView
        source="Clash detection"
        header={<ResultSource source="Hard clashes" models={[{ id: 'a', name: 'ARC' }, { id: 'b', name: 'STR' }]} population="82 elements checked" />}
        coverage={<ResultCoverage status="partial" counts="3 of 4 rules ran" incomplete={['1 rule matched no elements']} />}
        summary={<p>SUMMARY</p>}
        filters={<p>FILTERS</p>}
        actions={<p>ACTIONS</p>}
        rows={<p>ROWS</p>}
        evidence={<p>EVIDENCE</p>}
      />,
    );
    const region = ui.querySelector('section[aria-label="Clash detection results"]');
    assert.ok(region, 'the result is a named region');
    const body = text(region);
    const order = ['Hard clashes', 'Models (2): ARC, STR', '82 elements checked', 'Partial', '3 of 4 rules ran',
      '1 rule matched no elements', 'SUMMARY', 'FILTERS', 'ACTIONS', 'ROWS', 'EVIDENCE'];
    let cursor = -1;
    for (const part of order) {
      const at = body.indexOf(part);
      assert.ok(at > cursor, `"${part}" follows the previous region (${body})`);
      cursor = at;
    }
    assert.ok(region.querySelector('[role="toolbar"][aria-label="Result actions"]'), 'actions are one toolbar');
    assert.ok(region.querySelector('section[aria-label="Evidence details"]'), 'evidence is its own region');
    assert.ok(region.querySelector('ul[aria-label="Incomplete"]'), 'every known gap is listed');
  });

  it('states every status in words, with an icon that is not the only signal', () => {
    const labels = new Set<string>();
    for (const status of STATUSES) {
      const ui = render(<StatusChip status={status} />);
      const chip = ui.querySelector(`[data-status="${status}"]`);
      assert.ok(chip, status);
      const label = text(chip);
      assert.ok(label.length > 0, `${status} has a visible label`);
      assert.ok(chip.querySelector('svg[aria-hidden="true"]'), `${status} has a decorative icon`);
      labels.add(label);
    }
    assert.equal(labels.size, STATUSES.length, 'no two statuses share a label');
    // The charter's proposal vocabulary, verbatim.
    for (const word of ['Draft', 'Ready to review', 'Applying', 'Applied', 'Partial', 'Stale', 'Failed']) {
      assert.ok(labels.has(word), word);
    }
  });

  it('distinguishes no population, no findings, failed, unsupported, partial and filtered', () => {
    const kinds: ResultStateKind[] = ['no-population', 'no-findings', 'failed', 'unsupported', 'partial', 'filtered'];
    const titles = new Set<string>();
    for (const kind of kinds) {
      const ui = render(<ResultState kind={kind} details={['first', false, 'second']} />);
      const state = ui.querySelector(`[data-result-state="${kind}"]`);
      assert.ok(state);
      assert.equal(state.getAttribute('role'), kind === 'failed' ? 'alert' : 'status');
      const lines = [...state.querySelectorAll('p')].map((line) => line.textContent);
      titles.add(lines[0] ?? '');
      assert.deepEqual(lines.slice(1), ['first', 'second'], 'falsy detail lines are dropped, the rest kept in order');
    }
    assert.equal(titles.size, kinds.length, 'each kind has its own default heading');
  });

  it('never offers an empty scope, except the one already chosen', () => {
    const ui = render(<ScopeControl value="all" onValueChange={() => {}} counts={{ selected: 0, filtered: 12, all: 40 }} />);
    const radios = [...ui.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    assert.deepEqual(radios.map((radio) => radio.disabled), [true, false, false]);
    assert.deepEqual(radios.map((radio) => text(radio.closest('label')!)), ['Selected (0)', 'Filtered (12)', 'All (40)']);
    cleanup();
    const chosen = render(<ScopeControl value="selected" onValueChange={() => {}} counts={{ selected: 0, filtered: 0, all: 40 }} />);
    assert.equal(chosen.querySelector<HTMLInputElement>('input[value="selected"]')?.disabled, false);
  });

  it('separates highlighted, selected and in-batch counts', () => {
    const ui = render(<SelectionSummary highlighted selected={3} included={2} />);
    assert.equal(text(ui), '1 in focus · 3 selected · 2 in batch');
    cleanup();
    assert.equal(text(render(<SelectionSummary highlighted={false} selected={0} />)), '');
  });

  it('names the artifact and keeps its actions and assistant entry together', () => {
    const ui = render(
      <ArtifactHeader name="Fire safety" sourceScope="12 specifications" revision="Version 1.0" state="draft"
        actions={<button type="button">Save</button>} assistant={<button type="button">Explain</button>} />,
    );
    const header = ui.querySelector('header[aria-label="Fire safety artifact"]');
    assert.ok(header);
    assert.equal(header.querySelector('h3')?.textContent, 'Fire safety');
    assert.match(text(header), /12 specifications.*Draft.*Version 1\.0.*Save.*Explain/);
  });
});

/** "Select all" over 50 loaded rows of a 250-row population, with a controllable retrieval. */
function SelectionHarness({ resolve, onRun }: { resolve: () => Promise<readonly string[]>; onRun: (keys: ReadonlySet<string>) => void }) {
  const page = useRef(Array.from({ length: 50 }, (_, i) => `row-${i}`)).current;
  const selection = useResultSelection({ populationTotal: 250, resolvePopulation: useCallback(resolve, [resolve]), populationKey: 'fixed' });
  return (
    <>
      <SelectAllControl selection={selection} pageKeys={page} populationTotal={250} />
      <ResultAction acts="population" selection={selection.state} label="Export all matching" onRun={onRun} />
      <ResultAction acts="selected" selection={selection.state} label="Export selected" onRun={onRun} />
    </>
  );
}

describe('select all and scoped actions (U02, #6925)', () => {
  it('says which "all" it means and waits for the authoritative population', async () => {
    let answer: (keys: readonly string[]) => void = () => {};
    const resolve = () => new Promise<readonly string[]>((done) => { answer = done; });
    const runs: number[] = [];
    const ui = render(<SelectionHarness resolve={resolve} onRun={(keys) => runs.push(keys.size)} />);

    const populationAction = () => button(ui, /^Export all matching$/)!;
    assert.equal(populationAction().disabled, true, 'nothing selected');
    click(button(ui, /Select all 50 on this page/)!);
    assert.match(text(ui), /All 50 on this page selected\./);
    assert.equal(populationAction().disabled, true, 'the page is not the population');
    assert.equal(button(ui, /^Export selected$/)!.disabled, false);

    click(button(ui, /Select all 250 matching results/)!);
    assert.match(text(ui), /Retrieving all 250 matching results/);
    assert.equal(populationAction().disabled, true, 'still retrieving');
    assert.equal(button(ui, /^Export selected$/)!.disabled, true, 'the page subset cannot stand in while retrieving');

    await act(async () => { answer(Array.from({ length: 250 }, (_, i) => `row-${i}`)); });
    await waitFor(() => /All 250 matching results are selected\./.test(text(ui)), 'population resolved');
    assert.equal(populationAction().disabled, false);
    click(populationAction());
    assert.deepEqual(runs, [250], 'the action runs over the retrieved keys, not the page');

    click(button(ui, /Clear selection/)!);
    assert.equal(populationAction().disabled, true);
  });

  it('offers a retry when the population cannot be retrieved', async () => {
    let attempts = 0;
    const resolve = () => { attempts++; return Promise.reject(new Error('worker gone')); };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const ui = render(<SelectionHarness resolve={resolve} onRun={() => {}} />);
      click(button(ui, /Select all 50 on this page/)!);
      await act(async () => { button(ui, /Select all 250 matching results/)!.click(); });
      assert.match(text(ui), /could not be retrieved/);
      assert.equal(button(ui, /^Export all matching$/)!.disabled, true);
      await act(async () => { button(ui, /^Retry$/)!.click(); });
      assert.equal(attempts, 2, 'retried');
    } finally {
      console.warn = warn;
    }
  });
});
