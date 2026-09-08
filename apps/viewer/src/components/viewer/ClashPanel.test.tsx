/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `groupClashes({ by: 'cluster' })` (packages/clash/src/grouping.ts) already
 * collapses spatially-related element pairs into a smaller number of
 * coordination issues — measured on a real road/bridge model, 8 IfcBeam ×
 * IfcBeam pairs collapse into exactly 2 clusters (one per abutment). Before
 * this change, the viewer's `useClash` hook already computed this grouping
 * into `clashGroups` on every run (for the BCF export dialog), but
 * `ClashPanel` — the results list the user actually looks at — never
 * rendered it: the panel only ever showed the flat 8-pair list, with no way
 * to see "2 issues" anywhere.
 *
 * These tests render the real `ClashPanel` against a seeded store using the
 * REAL `groupClashes` (not a mock), so a failure here means the panel itself
 * doesn't surface the grouping — not that the grouping algorithm is broken
 * (that's covered in packages/clash).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { groupClashes, summarizeClashes, type Clash, type ClashElementRef, type ClashResult } from '@ifc-lite/clash';
import { ClashPanel } from './ClashPanel.js';

function ref(key: string, ref: number): ClashElementRef {
  return { key, ref, model: 'm1', tag: 'IfcBeam', name: key };
}

/** One clash between two beams, centred at `point`, all in the same rule + type-pair
 *  bucket so `groupClashes({ by: 'cluster' })` only splits on spatial distance. */
function beamClash(id: string, point: [number, number, number]): Clash {
  return {
    id,
    a: ref(`${id}-a`, id.charCodeAt(0) * 2),
    b: ref(`${id}-b`, id.charCodeAt(0) * 2 + 1),
    rule: 'all-clashes',
    status: 'hard',
    distance: -0.05,
    point,
    bounds: { min: point, max: point },
    severity: 'major',
  };
}

/** 8 beam×beam pairs in two tight spatial clusters ~100 m apart — the
 *  measured motivating case: one cluster per bridge abutment. Well inside the
 *  default 1.5 m cluster epsilon within a cluster, far outside it between. */
function bridgeAbutmentResult(): ClashResult {
  const clashes: Clash[] = [
    beamClash('c1', [0, 0, 0]),
    beamClash('c2', [0.2, 0, 0]),
    beamClash('c3', [0, 0.3, 0]),
    beamClash('c4', [0.1, 0.1, 0.1]),
    beamClash('c5', [100, 0, 0]),
    beamClash('c6', [100.2, 0, 0]),
    beamClash('c7', [100, 0.3, 0]),
    beamClash('c8', [100.1, 0.1, 0.1]),
  ];
  // Summarize through the REAL tally, not a hand-built object: an earlier
  // revision pinned `byTypePair: { 'IfcBeam|IfcBeam': 8 }`, a key shape
  // production never emits (`summarizeClashes` joins with ' vs '), so the
  // fixture proved nothing about the real key format.
  const summary = summarizeClashes(clashes);
  assert.equal(
    summary.byTypePair['IfcBeam vs IfcBeam'],
    clashes.length,
    'fixture sanity: the type-pair bucket must sit under the sorted "<a> vs <b>" key, the format ClashPanel looks buckets up by',
  );
  return {
    clashes,
    summary,
    rulesRun: [{ id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' }],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

// `@tanstack/react-virtual` measures the scroll container's real
// `offsetHeight` to decide which rows are in the visible range; happy-dom
// (no real layout engine) always reports 0, so with no stub every virtualized
// row silently fails to render — the panel would look empty regardless of
// what's under test. Give it a plausible viewport once, globally.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderPanel(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ClashPanel />);
  });
  mounted.push({ root, container });
  return container;
}

function resetStore(): void {
  useViewerStore.setState({
    clashResult: null,
    clashGroups: null,
    clashSelectedId: null,
    clashSortBy: 'severity',
    clashHideTouching: false,
    clashStatusFilter: new Set(['open', 'resolved', 'accepted']),
  });
}

describe('ClashPanel surfaces the existing clash grouping as coordination issues', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    resetStore();
  });

  it('shows the clustered issue count (2), not just the 8-pair total, once a result with groups is loaded', () => {
    const result = bridgeAbutmentResult();
    const groups = groupClashes(result, { by: 'cluster' }); // epsilon defaults to 1.5 m
    assert.equal(groups.length, 2, 'fixture sanity: 8 pairs must cluster into exactly 2 groups at the default epsilon');

    useViewerStore.setState({ clashResult: result, clashGroups: groups });
    const container = renderPanel();

    // The 8-pair total must still be visible (RED-safe: this already passes today).
    assert.ok(container.textContent?.includes('8'), 'the raw pair total (8) must still be shown');

    // The issue count (2) must ALSO be surfaced somewhere in the panel — this is
    // the behavior under test, and is what fails before the fix.
    const text = container.textContent ?? '';
    const mentionsTwoIssues = /\b2\b[^0-9]{0,20}issue/i.test(text) || /issue[^0-9]{0,20}\b2\b/i.test(text);
    assert.ok(mentionsTwoIssues, `expected the panel to surface "2 issues" somewhere; got: ${text}`);
  });

  it('switching to the issues view lists 2 group rows, each expandable to its member pairs', async () => {
    const result = bridgeAbutmentResult();
    const groups = groupClashes(result, { by: 'cluster' });
    useViewerStore.setState({ clashResult: result, clashGroups: groups });
    const container = renderPanel();

    const issuesToggle = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Issues',
    );
    assert.ok(issuesToggle instanceof HTMLButtonElement, 'expected an "Issues" view toggle button');
    await act(async () => {
      issuesToggle.click();
    });

    // Two group header rows, each showing its member count (4 pairs each).
    const groupHeaders = [...container.querySelectorAll('button[aria-expanded]')].filter((b) =>
      /\b4\b/.test(b.textContent ?? ''),
    );
    assert.equal(groupHeaders.length, 2, 'expected two issue-group headers, each showing 4 member pairs');

    // Groups render expanded by default (`collapsed` starts empty). Each
    // member row names its two elements ("c1-a", "c1-b", ...) — text that
    // appears ONLY in member rows, never in a group header's title (which
    // reads "IfcBeam vs IfcBeam (all-clashes)") — so counting those mentions
    // distinguishes "members rendered" from "just the header text".
    const memberNamePattern = /c[1-8]-[ab]\b/g;
    const memberMentions = () => (container.textContent?.match(memberNamePattern) ?? []).length;
    const baseline = memberMentions();
    assert.equal(baseline, 16, 'sanity: both clusters (4 members × 2 names) are shown by default');

    // Collapsing one group must hide exactly its 4 members (8 name mentions) —
    // the raw data is not removed, only re-organized (a collapsed section
    // renders only its header, per `displayRows`).
    const firstGroupHeader = groupHeaders[0] as HTMLButtonElement;
    assert.equal(firstGroupHeader.getAttribute('aria-expanded'), 'true', 'group starts expanded');
    await act(async () => {
      firstGroupHeader.click();
    });
    assert.equal(firstGroupHeader.getAttribute('aria-expanded'), 'false', 'click collapses an expanded group');
    assert.equal(memberMentions(), baseline - 8, 'collapsing the group must hide its 4 member pairs');

    // Expanding it again must bring those member pairs back.
    await act(async () => {
      firstGroupHeader.click();
    });
    assert.equal(firstGroupHeader.getAttribute('aria-expanded'), 'true', 'click re-expands a collapsed group');
    assert.equal(memberMentions(), baseline, 'expanding the group again must reveal its member pairs');
  });

  it('the issue count stays filter-aware: "Hide touching" that empties a cluster drops it from the count too', () => {
    // One cluster's clashes are all `status: 'touch'` (zero-penetration
    // contact, `isTouching` from `@ifc-lite/clash`). With "Hide touching" on,
    // `issueSections` drops that cluster's now-empty section — the header
    // count must match, not just read `groups.length` (which still counts
    // BOTH clusters regardless of the filter).
    const result = bridgeAbutmentResult();
    const touchingResult: ClashResult = {
      ...result,
      clashes: result.clashes.map((c) => (c.point[0] >= 100 ? { ...c, status: 'touch' as const } : c)),
    };
    const groups = groupClashes(touchingResult, { by: 'cluster' });
    assert.equal(groups.length, 2, 'fixture sanity: still 2 spatial clusters');

    useViewerStore.setState({ clashResult: touchingResult, clashGroups: groups, clashHideTouching: true });
    const container = renderPanel();

    const issuesToggle = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Issues',
    );
    assert.ok(issuesToggle instanceof HTMLButtonElement, 'expected an "Issues" view toggle button');
    act(() => {
      issuesToggle.click();
    });

    // Exactly one group header rendered (the touching cluster's section has no
    // visible members left, per `issueSections`'s `.filter((s) => s.items.length > 0)`).
    // Group headers carry `aria-label="Expand/Collapse <group label>"`; the
    // per-clash "show both objects" toggle also has `aria-expanded` but no
    // `aria-label`, so this selector is specific to group rows.
    const groupHeaders = container.querySelectorAll('button[aria-expanded][aria-label]');
    assert.equal(groupHeaders.length, 1, 'the emptied cluster must not render a group row either');

    // The header count next to "Issues" must say 1, not 2. (Adjacent spans mean
    // `textContent` has no space between the number and the word, e.g. "1issue".)
    const text = container.textContent ?? '';
    assert.ok(/(?:^|[^0-9])1\s*issue/i.test(text), `expected the header to read "1 issue"; got: ${text}`);
    assert.ok(!/(?:^|[^0-9])2\s*issues?/i.test(text), `header must not also claim 2 issues; got: ${text}`);
  });
});
