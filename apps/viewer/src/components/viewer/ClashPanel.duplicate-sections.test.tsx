/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ClashPanel renders a duplicate scan as coincident-set sections (#2530
 * review blocker).
 *
 * The blocker's exact symptom: `groupDuplicateSets` was stored in
 * `clashGroups`, which no component read, so three coincident columns still
 * rendered as three sibling pair rows under a generic severity header. The
 * section-builder maths is unit-tested in `duplicate-set-sections.test.ts`;
 * this renders the REAL panel over a seeded store and pins the glue — the
 * panel actually consumes `clashGroups` — which is precisely the line whose
 * absence shipped the dead state.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  findDuplicates,
  groupClashes,
  groupDuplicateSets,
  type Clash,
  type ClashElement,
  type ClashElementRef,
  type ClashResult,
} from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { ClashPanel } from './ClashPanel.js';

let nextRef = 1;

function element(key: string): ClashElement {
  return {
    key,
    ref: nextRef++,
    model: 'm',
    tag: 'IfcColumn',
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    positions: new Float32Array(0),
    indices: new Uint32Array(6),
  };
}

// happy-dom performs no layout, so every element measures 0×0 and the panel's
// row virtualizer (which reads `offsetWidth`/`offsetHeight`, see
// @tanstack/virtual-core `getRect`) computes an empty window — no section
// header would render no matter what the panel does. Give every element a
// fixed size so the virtual list actually materializes rows. Scoped to this
// test file's process (node:test runs each file in its own child process).
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });

let root: Root | null = null;
let container: HTMLElement | null = null;

async function renderPanel(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ClashPanel />);
  });
}

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

/** Hand-built pairwise clash for a NORMAL (non-duplicate) scan fixture. */
let clashSeq = 0;
function wallClash(): Clash {
  clashSeq += 1;
  const refOf = (key: string): ClashElementRef => ({ model: 'm', key, tag: 'IfcWall', ref: clashSeq });
  return {
    id: `w${clashSeq}`,
    a: refOf(`GUID_A_${clashSeq}`),
    b: refOf(`GUID_B_${clashSeq}`),
    rule: 'all-clashes',
    status: 'hard',
    distance: -0.05,
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity: 'major',
  };
}

/** A 3-clash single-cluster clash scan (NOT a duplicate scan), plus its groups. */
function normalScan(): { result: ClashResult; groups: ReturnType<typeof groupClashes> } {
  const clashes = [wallClash(), wallClash(), wallClash()];
  const result: ClashResult = {
    clashes,
    summary: {
      total: 3,
      byRule: { 'all-clashes': 3 },
      byTypePair: { 'IfcWall vs IfcWall': 3 },
      bySeverity: { critical: 0, major: 3, minor: 0, info: 0 },
    },
    rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
  return { result, groups: groupClashes(result, { by: 'cluster', epsilon: 1.5 }) };
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    [...container!.querySelectorAll('button')].find((b) => b.textContent === text) ?? null
  );
}

describe('ClashPanel — duplicate scan sections (#2530)', () => {
  it('shows ONE coincident-set header for a triplicated column, not a generic bucket', async () => {
    const result = findDuplicates([element('a'), element('b'), element('c')]);
    assert.equal(result.clashes.length, 3, 'fixture: 3 pairwise rows');
    useViewerStore.setState({
      clashResult: result,
      clashGroups: groupDuplicateSets(result),
    });
    await renderPanel();
    // This is the discriminating assertion: the pre-#2530 panel bucketed the
    // three pair rows under a generic severity header and never rendered a
    // set title anywhere. (No companion "generic header is gone" assertion:
    // the severity summary chips legitimately keep the severity words on
    // screen in both implementations, so no such string test can discriminate.)
    const text = container!.textContent ?? '';
    assert.ok(
      text.includes('3 coincident IfcColumn objects'),
      `panel must render the set title; got: ${text.slice(0, 400)}`,
    );
  });
});

describe('ClashPanel - Pairs/Issues toggle vs duplicate scans (#2535)', () => {
  it('hides the toggle and proximity wording during a duplicate scan', async () => {
    // Proximity grouping does not apply to a duplicate scan: its grouping is
    // coincident SETS. Offering "Issues" (with the "within Xm" tooltip) there
    // presents a control whose wording describes a different mechanism.
    const result = findDuplicates([element('a'), element('b'), element('c')]);
    useViewerStore.setState({
      clashResult: result,
      clashGroups: groupDuplicateSets(result),
      clashGroupsKind: 'manual',
    });
    await renderPanel();
    // `assert.ok(x === null)`, not `assert.equal(x, null)`: on failure the
    // latter feeds the happy-dom element into the assertion diff, whose deep
    // inspection of the DOM graph exhausts the heap before the test can fail.
    assert.ok(buttonByText('Issues') === null, 'no Issues toggle during a duplicate scan');
    assert.ok(buttonByText('Pairs') === null, 'no Pairs toggle during a duplicate scan');
    const text = container!.textContent ?? '';
    assert.ok(!text.includes('Grouped by proximity'), 'no proximity wording during a duplicate scan');
    assert.ok(!/\bissues?\b/i.test(text), `no issue-count wording during a duplicate scan; got: ${text.slice(0, 400)}`);
  });

  it('keeps the toggle for a normal clash scan, and clicking Issues actually switches the view', async () => {
    // The suppression above must not defuse the control for normal scans:
    // drive it: click Issues and require the summary to re-read as issues.
    const { result, groups } = normalScan();
    useViewerStore.setState({ clashResult: result, clashGroups: groups, clashGroupsKind: 'derived' });
    await renderPanel();
    const issuesBtn = buttonByText('Issues');
    assert.ok(issuesBtn, 'a normal clash scan keeps the Pairs/Issues toggle');
    await act(async () => {
      issuesBtn.click();
    });
    const text = container!.textContent ?? '';
    // textContent concatenates the big-number span and the label with no
    // whitespace, so match the label alone ("1issue · 3 pairs" as rendered).
    assert.ok(
      text.includes('issue · 3 pairs'),
      `Issues view must group the single cluster as one issue; got: ${text.slice(0, 400)}`,
    );
    assert.ok(text.includes('Grouped by proximity'), 'the proximity label stays for normal scans');
  });

  it('a stale Issues selection does not leak into a subsequent duplicate scan', async () => {
    // resultView is component state that survives a result change: pick
    // Issues on a clash scan, then run "Find duplicates" needs the duplicate
    // result must render its coincident-set sections, not a proximity view.
    const { result, groups } = normalScan();
    useViewerStore.setState({ clashResult: result, clashGroups: groups, clashGroupsKind: 'derived' });
    await renderPanel();
    const issuesBtn = buttonByText('Issues');
    assert.ok(issuesBtn);
    await act(async () => {
      issuesBtn.click();
    });
    const dup = findDuplicates([element('d'), element('e'), element('f')]);
    await act(async () => {
      useViewerStore.setState({
        clashResult: dup,
        clashGroups: groupDuplicateSets(dup),
        clashGroupsKind: 'manual',
      });
    });
    const text = container!.textContent ?? '';
    assert.ok(
      text.includes('3 coincident IfcColumn objects'),
      `the duplicate scan must render set sections despite the stale Issues choice; got: ${text.slice(0, 400)}`,
    );
    assert.ok(!text.includes('Grouped by proximity'), 'no proximity wording after switching to a duplicate scan');
  });
});
