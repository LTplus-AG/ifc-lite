/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * User-defined clash exclusions, end to end through the real panel.
 *
 * The engine has always been able to skip a pair, but only for exclusions the
 * IFC itself declares (an opening in its host, siblings of an aggregate). A
 * coordinator looking at a road/bridge model sees the opposite problem: most
 * remaining "clashes" are DESIGNED interpenetration — ballast around a rail,
 * stacked pavement courses — and there was no way to say so. These tests drive
 * the panel: exclude a whole type pair in one action, exclude one specific
 * element pair, see what each rule is hiding, and undo it.
 *
 * They go through `setClashResult`, i.e. the same store path a real run takes,
 * so a regression that filtered only in the component (leaving the store's
 * groups/summary stale) would still fail here.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import type { Clash, ClashElementRef, ClashResult } from '@ifc-lite/clash';
import { ClashPanel } from './ClashPanel.js';

Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });

function ref(key: string, id: number, tag: string, name: string): ClashElementRef {
  return { key, ref: id, model: 'm1', tag, name };
}

function clashOf(id: string, a: ClashElementRef, b: ClashElementRef, point: [number, number, number]): Clash {
  return {
    id,
    a,
    b,
    rule: 'all-clashes',
    status: 'hard',
    distance: -0.075,
    point,
    bounds: { min: point, max: point },
    severity: 'major',
  };
}

const rail1 = ref('GUID_RAIL_1', 10, 'IfcRail', 'Rail 1');
const rail2 = ref('GUID_RAIL_2', 11, 'IfcRail', 'Rail 2');
const ballast = ref('GUID_COURSE_1', 20, 'IfcCourse', 'Ballast');
const beam1 = ref('GUID_BEAM_1', 30, 'IfcBeam', 'Beam 1');
const beam2 = ref('GUID_BEAM_2', 31, 'IfcBeam', 'Beam 2');

/**
 * Two designed rail-in-ballast overlaps plus one genuine beam×beam clash — the
 * shape of the real complaint: "the real answer here is only 2 beams clashing".
 */
function roadModelResult(): ClashResult {
  const clashes = [
    clashOf('c1', rail1, ballast, [0, 0, 0]),
    clashOf('c2', rail2, ballast, [40, 0, 0]),
    clashOf('c3', beam1, beam2, [80, 0, 0]),
  ];
  return {
    clashes,
    summary: {
      total: 3,
      byRule: { 'all-clashes': 3 },
      byTypePair: { 'IfcCourse vs IfcRail': 2, 'IfcBeam vs IfcBeam': 1 },
      bySeverity: { critical: 0, major: 3, minor: 0, info: 0 },
    },
    rulesRun: [{ id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' }],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

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

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')] as HTMLButtonElement[];
}

/** First button whose visible text or aria-label matches `re`. */
function findButton(container: HTMLElement, re: RegExp): HTMLButtonElement | undefined {
  return buttons(container).find((b) => re.test(b.textContent ?? '') || re.test(b.getAttribute('aria-label') ?? ''));
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

/** Expand the detail row of the clash whose summary line mentions `name`. */
async function expandRow(container: HTMLElement, name: string): Promise<void> {
  const row = [...container.querySelectorAll('div')].find(
    (d) => d.className.includes('items-stretch') && (d.textContent ?? '').includes(name),
  );
  assert.ok(row, `expected a clash row mentioning ${name}`);
  const toggle = [...row.querySelectorAll('button')].find((b) => b.hasAttribute('aria-expanded'));
  assert.ok(toggle instanceof HTMLButtonElement, 'expected an expand toggle on the clash row');
  await click(toggle);
}

function clashRowCount(container: HTMLElement): number {
  return [...container.querySelectorAll('div')].filter((d) => d.className.includes('items-stretch')).length;
}

function resetStore(): void {
  localStorage.clear();
  useViewerStore.setState({
    clashResult: null,
    clashRawResult: null,
    clashGroups: null,
    clashSelectedId: null,
    clashSortBy: 'severity',
    clashHideTouching: false,
    clashStatusFilter: new Set(['open', 'resolved', 'accepted']),
    clashExclusions: [],
    clashExclusionCounts: new Map(),
    clashSuppressedCount: 0,
  });
}

describe('ClashPanel: user-defined exclusions', () => {
  beforeEach(() => {
    resetStore();
    act(() => {
      useViewerStore.getState().setClashResult(roadModelResult());
    });
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

  it('offers a type-pair exclusion from an expanded clash, and one click clears every clash of that pair', async () => {
    const container = renderPanel();
    assert.equal(clashRowCount(container), 3, 'fixture sanity: three clashes before any exclusion');

    await expandRow(container, 'Rail 1');
    const excludeType = findButton(container, /Exclude all IfcRail × IfcCourse|Exclude all IfcCourse × IfcRail/);
    assert.ok(excludeType, 'expected an "exclude all <TypeA> × <TypeB>" action on the expanded clash');
    await click(excludeType);

    // Both rail-in-ballast overlaps are gone; the real beam clash remains.
    assert.equal(clashRowCount(container), 1);
    assert.ok((container.textContent ?? '').includes('Beam 1'), 'the genuine beam clash must survive');
    assert.equal(useViewerStore.getState().clashSuppressedCount, 2);
  });

  it('lists each exclusion with how many clashes it is hiding', async () => {
    const container = renderPanel();
    await expandRow(container, 'Rail 1');
    await click(findButton(container, /Exclude all IfcRail × IfcCourse|Exclude all IfcCourse × IfcRail/)!);

    const text = container.textContent ?? '';
    assert.match(text, /IfcRail × IfcCourse|IfcCourse × IfcRail/, 'the rule must be visible so the user knows what is hidden');
    assert.match(text, /\b2\b[^0-9]{0,20}hidden|hidden[^0-9]{0,20}\b2\b/i, 'the panel must say how many clashes the rule hides');
  });

  it('removing an exclusion brings its clashes back', async () => {
    const container = renderPanel();
    await expandRow(container, 'Rail 1');
    await click(findButton(container, /Exclude all IfcRail × IfcCourse|Exclude all IfcCourse × IfcRail/)!);
    assert.equal(clashRowCount(container), 1);

    const remove = findButton(container, /^Remove exclusion/);
    assert.ok(remove, 'expected a per-rule remove control');
    await click(remove);

    assert.equal(clashRowCount(container), 3);
    assert.equal(useViewerStore.getState().clashExclusions.length, 0);
    assert.equal(useViewerStore.getState().clashSuppressedCount, 0);
  });

  it('offers a one-sided rule per class of the clash, and one click clears everything touching it', async () => {
    const container = renderPanel();
    await expandRow(container, 'Rail 1');

    // Both classes of the expanded clash are offered, so the user picks which
    // one is "by design" rather than being handed the pair as a package.
    const anyRail = findButton(container, /Exclude anything touching IfcRail/);
    const anyCourse = findButton(container, /Exclude anything touching IfcCourse/);
    assert.ok(anyRail, 'expected the side-A class action');
    assert.ok(anyCourse, 'expected the side-B class action');
    // Live reach, before the rule exists: both classes are in 2 of the 3
    // clashes — IfcCourse on side B twice, IfcRail on side A twice.
    assert.match(anyCourse.textContent ?? '', /IfcCourse\s*\(2\)/);
    assert.match(anyRail.textContent ?? '', /IfcRail\s*\(2\)/);

    await click(anyCourse);

    // IfcCourse is on side B of both rail overlaps: one rule takes both.
    assert.equal(clashRowCount(container), 1);
    assert.ok((container.textContent ?? '').includes('Beam 1'), 'the genuine beam clash must survive');
    assert.equal(useViewerStore.getState().clashSuppressedCount, 2);
    assert.equal(useViewerStore.getState().clashExclusions[0]?.kind, 'typeAny');
  });

  it('offers a single one-sided action on a same-class clash, counted once', async () => {
    const container = renderPanel();
    await expandRow(container, 'Beam 1');
    const anyBeam = buttons(container).filter((b) => /Exclude anything touching IfcBeam/.test(b.textContent ?? ''));
    // One class on both sides is one action, and the single beam×beam clash
    // must be counted once, not twice.
    assert.equal(anyBeam.length, 1);
    assert.doesNotMatch(anyBeam[0]?.textContent ?? '', /\(\d+\)/);

    await click(anyBeam[0]!);
    assert.equal(useViewerStore.getState().clashSuppressedCount, 1);
    assert.equal(clashRowCount(container), 2, 'the rail overlaps are untouched by a beam rule');
  });

  it('labels the one-sided rule distinguishably and reports its reach', async () => {
    const container = renderPanel();
    await expandRow(container, 'Rail 1');
    await click(findButton(container, /Exclude anything touching IfcCourse/)!);

    const text = container.textContent ?? '';
    assert.match(text, /IfcCourse × anything/, 'the wide rule must not read like the IfcCourse × IfcCourse pair rule');
    assert.match(text, /\b2\b[^0-9]{0,20}hidden|hidden[^0-9]{0,20}\b2\b/i, 'the panel must say how many clashes it hides');

    // The kind badge must not read the same as a two-sided or element rule.
    const badges = [...container.querySelectorAll('li span.uppercase')].map((s) => s.textContent);
    assert.deepEqual(badges, ['any']);

    // Removable exactly like the other kinds.
    await click(findButton(container, /^Remove exclusion/)!);
    assert.equal(clashRowCount(container), 3);
  });

  it('an element-pair exclusion hides only that one clash', async () => {
    const container = renderPanel();
    await expandRow(container, 'Rail 1');
    const excludeOne = findButton(container, /Exclude (just )?this pair/i);
    assert.ok(excludeOne, 'expected an "exclude this pair" action alongside the type-pair one');
    await click(excludeOne);

    assert.equal(clashRowCount(container), 2, 'only the one element pair is hidden');
    assert.equal(useViewerStore.getState().clashSuppressedCount, 1);
    assert.ok((container.textContent ?? '').includes('Rail 2'), 'the type sibling must still be listed');
  });
});
