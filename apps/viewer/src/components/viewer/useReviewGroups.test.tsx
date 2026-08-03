/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Isolated real-DOM reproduction of the CodeRabbit finding on
 * `ExportChangesButton.tsx:159` (PR #1967): `groups` used to be synced via a
 * passive `useEffect`, so opening the review would commit ONE React render
 * with `reviewOpen === true` but `groups` still `[]` (the "no pending
 * changes" empty state, since `ExportChangesReviewDialog`'s `isEmpty` treats
 * `[].every(...)` as vacuously true) — flashed on screen for one commit
 * before a SECOND, later commit replaced it with the real list.
 *
 * `useReviewGroups` (extracted from `ExportChangesButton.tsx` — see that
 * file) is tested here directly, mounted under a bare `<div>` rather than
 * `ExportChangesReviewDialog`'s real Radix `Dialog`: mounting through the
 * real dialog makes this bug unobservable in this test's happy-dom + Node
 * harness (verified separately) — Radix's own `FocusScope` /
 * `DismissableLayer` / `Presence` layout effects trigger additional
 * synchronous re-renders while the dialog opens, and React flushes any
 * already-pending passive effect before each one (`flushPassiveEffects()`,
 * called internally whenever a new synchronous update is scheduled while one
 * is outstanding), which incidentally flushes this hook's own passive effect
 * before anything ever reaches the DOM — masking a plain `useEffect`
 * regression completely when observed through the full dialog, regardless of
 * which effect type is actually used.
 *
 * A `MutationObserver`, not tick-polling (`await` a microtask / macrotask /
 * `setTimeout(0)`), is what distinguishes "one commit" from "two commits
 * that happen to land close together": each React commit is a distinct
 * synchronous DOM mutation, and the browser (and happy-dom) batches only the
 * mutations belonging to ONE commit into each observer callback — so the
 * FIRST callback's content is genuinely the FIRST commit's content,
 * regardless of how many ticks later it's delivered. Plain tick-polling
 * cannot make this distinction reliably in this harness (verified
 * separately: a discrete DOM `click` can resolve its own passive-effect
 * flush within the same microtask/macrotask turn as the layout commit here,
 * well before any poll would observe a gap).
 *
 * CodeRabbit (PR #1967) flagged this `MutationObserver` approach itself: a
 * `MutationObserver` callback fires once per microtask checkpoint, not once
 * per React commit, so two commits landing back-to-back in the SAME
 * synchronous task could in principle be coalesced into one callback,
 * hiding an intermediate wrong frame. Tried and rejected as a fix: replacing
 * the `MutationObserver` with a per-commit recorder driven directly from the
 * component (a `commits` array appended to from `Harness`'s own effect —
 * tried both `useLayoutEffect` and `useEffect`) breaks the PASSING case.
 * With the `useLayoutEffect` fix in place, `useReviewGroups` still performs
 * TWO real React commits (initial `groups: []`, then the layout-effect's
 * `setGroups(...)`) — `useLayoutEffect` only guarantees the second commit
 * lands before the browser paints, it does not collapse the two commits
 * into one. A recorder tied to "did a commit happen" therefore observes
 * `'Empty'` as the first commit even on CORRECT code (verified: both
 * `useLayoutEffect`- and `useEffect`-based recorders fail the currently
 * passing case with `got: "Empty"`), which would make this test flag a
 * regression that isn't there. The two commits here are only EVER coalesced
 * into a single externally-observable state when they share the same task —
 * which is exactly when no external observer (a `MutationObserver`, a
 * browser paint, or a person watching the screen) could tell them apart
 * either. `MutationObserver`'s microtask-checkpoint batching is therefore a
 * faithful proxy for "was the wrong frame ever observable," not a
 * false-negative risk to route around, so it stays.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { useViewerStore } from '@/store/index.js';
import type { ChangedModelsResult } from '@/lib/export/model-changes.js';
import { useReviewGroups } from './ExportChangesButton.js';

function makeView(): MutablePropertyView {
  const view = new MutablePropertyView(null, 'model-1');
  view.setOnDemandExtractor((entityId) => entityId === 7 ? [{
    name: 'Pset_Base',
    globalId: 'g',
    properties: [{ name: 'Status', type: PropertyValueType.Label, value: 'Original' }],
  }] : []);
  view.setProperty(7, 'Pset_Base', 'Status', 'Edited', PropertyValueType.Label);
  return view;
}

/** A stable reference (not rebuilt per render) — matches how `ExportChangesButton` holds `changed`. */
const CHANGED: ChangedModelsResult = {
  models: [{
    id: 'model-1',
    name: 'model-1.ifc',
    schemaVersion: 'IFC4',
    ifcDataStore: null,
    changeCount: 1,
    isScheduleTarget: false,
  }],
  scheduleTargetModelId: null,
};

/** Bare harness: exercises `useReviewGroups` with no Dialog/Tooltip/Radix in the tree. */
function Harness() {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [groups] = useReviewGroups(reviewOpen, CHANGED);
  return (
    <>
      <button onClick={() => setReviewOpen(true)}>Open</button>
      <div data-testid="content">{reviewOpen ? (groups.length ? 'Edited' : 'Empty') : 'Closed'}</div>
    </>
  );
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

describe('useReviewGroups (CodeRabbit finding on ExportChangesButton.tsx:159, #1967)', () => {
  it('does not commit an empty-state frame before the populated one when the review opens', async () => {
    useViewerStore.setState({ mutationViews: new Map([['model-1', makeView()]]) });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });
    mounted.push({ root, container });

    const commits: string[] = [];
    let resolveFirstCommit: (() => void) | null = null;
    // Resolves the moment the FIRST post-click DOM mutation is delivered —
    // a real completion signal from the observer itself (CodeRabbit finding
    // on PR #1967: a fixed sleep is not a deterministic completion signal),
    // not a fixed sleep. The assertions below only ever look at
    // `commits[0]`, so there is nothing to gain by waiting any longer than
    // that: MutationObserver batches everything from one microtask
    // checkpoint into a single callback, so this first callback already
    // contains the FIRST commit's content in full (see the file header).
    const observer = new MutationObserver(() => {
      commits.push(container.textContent ?? '');
      resolveFirstCommit?.();
      resolveFirstCommit = null;
    });
    observer.observe(container, { childList: true, characterData: true, subtree: true });

    try {
      const button = container.querySelector('button');
      assert.ok(button, 'Open button must render');

      const firstCommit = new Promise<void>((resolve) => {
        resolveFirstCommit = resolve;
      });
      // Deliberately NOT wrapped in `act()` (CodeRabbit finding on PR #1967
      // asked for this; tried and reverted — verified empirically below).
      // React 19's `act()` (from the `react` package, unified for both
      // `react-dom/client` and `react-dom/test-utils`) flushes ALL pending
      // work — including passive effects — before returning, even for this
      // synchronous callback form: a probe harness with a plain `useEffect`
      // confirmed the effect had already committed by the time `act()`
      // returned, with no `await` and no explicit flush call. Wrapping this
      // dispatch in `act()` would therefore force both the `useLayoutEffect`
      // commit AND a regressed `useEffect`'s commit to settle before this
      // test ever gets to read anything, collapsing the exact two-commit
      // gap this test exists to catch — confirmed: with `act()` wrapping
      // this dispatch, reverting `useLayoutEffect` to `useEffect` in
      // `ExportChangesButton.tsx` no longer fails this test. This matches
      // the sibling `useScheduleFileImport.race.test.tsx`'s own `waitFor`,
      // which documents the identical tradeoff: a harmless "not wrapped in
      // act" console warning is accepted because `act()` would otherwise
      // hide the very intermediate state under test.
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      // A timeout guards against a genuine hang (e.g. a future regression
      // that stops re-rendering entirely) — it is a failure backstop, not
      // the completion signal itself.
      await Promise.race([
        firstCommit,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error('timed out waiting for the first DOM commit after opening the review')), 1000);
        }),
      ]);

      console.log(`[useReviewGroups.test] commits observed after click: ${commits.length}`);
      assert.ok(commits.length > 0, 'opening the review must produce at least one DOM commit');
      const firstCommitContent = commits[0];
      assert.ok(
        !firstCommitContent.includes('Empty'),
        `the FIRST commit that opens the review must not show the empty state while a real change exists — got: ${JSON.stringify(firstCommitContent)}`,
      );
      assert.ok(
        firstCommitContent.includes('Edited'),
        `the change must already be present in the FIRST commit, not a later one — got: ${JSON.stringify(firstCommitContent)}`,
      );
    } finally {
      observer.disconnect();
      for (const { root, container } of mounted.splice(0)) {
        act(() => {
          root.unmount();
        });
        container.remove();
      }
      useViewerStore.setState({ mutationViews: new Map() });
    }
  });
});
