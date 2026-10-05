/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Clash panel on the shared result chrome (U02, #6925):
 *   - an empty result says WHY it is empty (no rule applied, nothing found,
 *     or filters hide every finding) as distinct result states;
 *   - "select all" selects exactly the findings the filters show, a filter
 *     change drops that select-all but keeps individual picks;
 *   - the BCF archive export is scoped to the selected / filtered / all
 *     findings, pinned when the dialog opens.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Clash, ClashResult, ClashRuleCoverage, ClashSeverity } from '@ifc-lite/clash';
import { clashReviewKey } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { cleanup, click, render } from '@/test/render.js';
import { ClashPanel } from './ClashPanel.js';

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });

const initial = useViewerStore.getState();

function clash(id: string, tagA: string, severity: ClashSeverity): Clash {
  return {
    id,
    a: { key: `${id}-a`, ref: 1, model: 'm', tag: tagA },
    b: { key: `${id}-b`, ref: 2, model: 'm', tag: 'IfcColumn' },
    rule: 'hard-clash',
    status: 'hard',
    distance: -0.05,
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity,
  };
}

/** Three findings (2 major, 1 minor) from one rule; coverage as given. */
function result(clashes: Clash[], coverage?: ClashRuleCoverage[], rules = 1): ClashResult {
  const bySeverity: Record<ClashSeverity, number> = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const c of clashes) bySeverity[c.severity]++;
  return {
    clashes,
    summary: { total: clashes.length, byRule: { 'hard-clash': clashes.length }, byTypePair: {}, bySeverity },
    rulesRun: Array.from({ length: rules }, (_, i) => ({ id: `rule-${i}`, name: `Rule ${i}`, a: 'IfcWall', b: 'IfcSlab', mode: 'hard' as const })),
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
    ...(coverage ? { ruleCoverage: coverage } : {}),
  };
}

const THREE = [clash('c1', 'IfcWall', 'major'), clash('c2', 'IfcBeam', 'major'), clash('c3', 'IfcSlab', 'minor')];

afterEach(async () => {
  cleanup();
  useViewerStore.setState(initial, true);
});

async function mount(clashResult: ClashResult, reviews = new Map()) {
  useViewerStore.setState({ clashResult, clashGroups: [], clashHideTouching: false, clashReviews: reviews });
  let ui!: HTMLElement;
  await act(async () => { ui = render(<ClashPanel />); });
  return ui;
}

const text = (root: ParentNode) => root.textContent?.replace(/\s+/g, ' ') ?? '';
const button = (root: ParentNode, label: RegExp) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => label.test(candidate.textContent ?? ''));
describe('Clash panel empty result states (U02, #6925)', () => {
  it('a matrix that matched nothing is "no applicable elements", not "no findings"', async () => {
    const coverage = [{ rule: 'rule-0', matchedA: 0, matchedB: 4 }, { rule: 'rule-1', matchedA: 3, matchedB: 0 }];
    const ui = await mount(result([], coverage, 2));
    assert.ok(ui.querySelector('[data-result-state="no-population"]'), text(ui));
    assert.equal(ui.querySelector('[data-result-state="no-findings"]'), null);
    assert.match(text(ui), /did NOT run/);
  });

  it('every rule ran and found nothing: "no findings"', async () => {
    const ui = await mount(result([], [{ rule: 'rule-0', matchedA: 3, matchedB: 4 }]));
    assert.ok(ui.querySelector('[data-result-state="no-findings"]'));
  });

  it('some rules never ran: "partial", naming them', async () => {
    const coverage = [{ rule: 'rule-0', matchedA: 3, matchedB: 4 }, { rule: 'rule-1', matchedA: 0, matchedB: 2 }];
    const ui = await mount(result([], coverage, 2));
    const state = ui.querySelector('[data-result-state="partial"]');
    assert.ok(state);
    assert.match(text(state), /Rule 1/);
  });

  it('findings exist but the status filter hides them all: "filtered"', async () => {
    const reviews = new Map(THREE.map((c) => [clashReviewKey(c), { status: 'resolved' as const }]));
    const ui = await mount(result(THREE), reviews);
    await act(async () => { useViewerStore.getState().toggleClashStatusFilter('resolved'); });
    assert.ok(ui.querySelector('[data-result-state="filtered"]'), text(ui));
  });
});

describe('Clash panel selection (U02, #6925)', () => {
  it('select all selects exactly the filtered findings; a filter change drops it', async () => {
    const reviews = new Map([[clashReviewKey(THREE[2]), { status: 'resolved' as const }]]);
    const ui = await mount(result(THREE), reviews);
    click(button(ui, /Select all 3 matching results/)!);
    assert.match(text(ui), /All 3 matching results are selected\./);
    assert.doesNotMatch(text(ui), /\b3 selected/, 'the select-all line states the count once');
    assert.equal(button(ui, /Group selected \(3\)/)?.disabled, false);

    // Hiding the resolved finding changes the population: "all 3" no longer names it.
    await act(async () => { useViewerStore.getState().toggleClashStatusFilter('resolved'); });
    assert.doesNotMatch(text(ui), /\d selected/);
    assert.ok(button(ui, /Select all 2 matching results/), 'the offer now names the new population');
    assert.equal(button(ui, /Group selected/)?.disabled, true);
  });

  it('an individual pick survives a filter change', async () => {
    const reviews = new Map([[clashReviewKey(THREE[2]), { status: 'resolved' as const }]]);
    const ui = await mount(result(THREE), reviews);
    const boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .filter((box) => /clash/i.test(box.getAttribute('aria-label') ?? ''));
    assert.equal(boxes.length, 3, 'one grouping checkbox per finding');
    click(boxes[0]);
    await act(async () => { useViewerStore.getState().toggleClashStatusFilter('resolved'); });
    assert.match(text(ui), /1 selected/);
  });
});

describe('Clash BCF archive scope (U02, #6925)', () => {
  it('exports the selected, filtered or all findings, pinned at open', async () => {
    const reviews = new Map([[clashReviewKey(THREE[2]), { status: 'resolved' as const }]]);
    const ui = await mount(result(THREE), reviews);
    await act(async () => { useViewerStore.getState().toggleClashStatusFilter('resolved'); }); // 2 shown of 3
    const boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .filter((box) => /clash/i.test(box.getAttribute('aria-label') ?? ''));
    click(boxes[0]); // 1 selected

    const exportButton = ui.querySelector<HTMLButtonElement>('button[aria-label="Export the clashes as a BCF archive for another BCF tool"]');
    assert.ok(exportButton);
    await act(async () => { exportButton.click(); });
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog, 'the BCF export dialog opened');
    const radio = (scope: string) => dialog.querySelector<HTMLInputElement>(`input[type="radio"][value="${scope}"]`)!;
    const previewClashes = () => Number(dialog.querySelector('.text-2xl')?.textContent);

    assert.equal(radio('all').checked, true, 'all findings by default, as before');
    assert.equal(previewClashes(), 3);
    assert.match(text(radio('selected').closest('label')!), /Selected \(1\)/);
    assert.match(text(radio('filtered').closest('label')!), /Filtered \(2\)/);

    await act(async () => { radio('filtered').click(); });
    assert.equal(previewClashes(), 2, 'the hidden (resolved) finding is out of scope');
    await act(async () => { radio('selected').click(); });
    assert.equal(previewClashes(), 1);

    // Showing the resolved finding again does not change the export being prepared.
    await act(async () => { useViewerStore.getState().toggleClashStatusFilter('resolved'); });
    await act(async () => { radio('filtered').click(); });
    assert.equal(previewClashes(), 2, 'the filtered scope was pinned when the dialog opened');
  });
});
