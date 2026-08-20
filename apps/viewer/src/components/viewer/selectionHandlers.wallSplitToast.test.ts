/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `reassignWallOpenings` (wall-opening-reassign.ts) computes a `skipped`
 * count whenever a door/window's opening has a placement it can't
 * interpret — those openings are left attached to the wall segment that
 * `splitWallAtDistance` is about to tombstone, so they can end up
 * orphaned. The doc on `OpeningReassignSummary.skipped` says this exists
 * "so the caller can surface a warning toast", but the wall-split click
 * handler in `selectionHandlers.ts` only ever read `toLeft`/`toRight` —
 * `skipped` reached the toast call site and was discarded.
 *
 * These tests exercise `formatOpeningReassignSuffix` (the pure formatter
 * pulled out of the toast call) directly, and drive the real
 * `handleSelectionClick` split branch through the store to confirm the
 * `toast.info(...)` skipped-openings notice actually fires when
 * `openings.skipped > 0`, and does not fire when it's 0.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { handleSelectionClick, formatOpeningReassignSuffix } from './selectionHandlers.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

function fakeCtx(): MouseHandlerContext {
  const canvas = document.createElement('canvas');
  return {
    canvas,
    renderer: {},
    mouseState: { isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false },
    activeToolRef: { current: 'split' },
  } as unknown as MouseHandlerContext;
}

function fakeClick(): MouseEvent {
  return { clientX: 0, clientY: 0 } as MouseEvent;
}

describe('formatOpeningReassignSuffix (pure)', () => {
  it('renders a count when openings moved', () => {
    assert.equal(formatOpeningReassignSuffix({ toLeft: 1, toRight: 2, skipped: 0 }), ' (3 openings reassigned)');
    assert.equal(formatOpeningReassignSuffix({ toLeft: 1, toRight: 0, skipped: 0 }), ' (1 opening reassigned)');
  });

  it('renders nothing when no openings moved', () => {
    assert.equal(formatOpeningReassignSuffix({ toLeft: 0, toRight: 0, skipped: 0 }), '');
    assert.equal(formatOpeningReassignSuffix({ toLeft: 0, toRight: 0, skipped: 3 }), '');
  });
});

describe('wall split toast: skipped openings notice', () => {
  const originalSplit = useViewerStore.getState().splitWallAtDistance;
  const originalInfo = toast.info;
  const originalSuccess = toast.success;
  let infoCalls: string[];
  let successCalls: string[];

  beforeEach(() => {
    infoCalls = [];
    successCalls = [];
    (toast as { info: (m: string) => void }).info = (m: string) => infoCalls.push(m);
    (toast as { success: (m: string) => void }).success = (m: string) => successCalls.push(m);
    useViewerStore.setState({
      splitTargetModelId: 'm1',
      splitTargetExpressId: 42,
      splitHoverDistance: 1.5,
      splitMode: undefined,
      slabCutAnchor: null,
      clearSplitHover: () => {},
      setSelectedEntityId: () => {},
    } as Partial<ReturnType<typeof useViewerStore.getState>>);
  });

  afterEach(() => {
    (toast as { info: (m: string) => void }).info = originalInfo;
    (toast as { success: (m: string) => void }).success = originalSuccess;
    useViewerStore.setState({ splitWallAtDistance: originalSplit });
  });

  it('surfaces a toast when the split left openings unreassigned', async () => {
    useViewerStore.setState({
      splitWallAtDistance: () => ({
        ok: true,
        left: { expressId: 1, globalId: 101 },
        right: { expressId: 2, globalId: 102 },
        openings: { toLeft: 1, toRight: 0, skipped: 2 },
      }),
    } as Partial<ReturnType<typeof useViewerStore.getState>>);

    await handleSelectionClick(fakeCtx(), fakeClick());

    assert.equal(successCalls.length, 1, 'expected the wall-split success toast');
    assert.ok(
      infoCalls.some((m) => m.includes('2 openings could not be reassigned')),
      `expected a skipped-openings notice, got: ${JSON.stringify(infoCalls)}`,
    );
  });

  it('shows no skipped-openings notice when nothing was skipped', async () => {
    useViewerStore.setState({
      splitWallAtDistance: () => ({
        ok: true,
        left: { expressId: 1, globalId: 101 },
        right: { expressId: 2, globalId: 102 },
        openings: { toLeft: 1, toRight: 1, skipped: 0 },
      }),
    } as Partial<ReturnType<typeof useViewerStore.getState>>);

    await handleSelectionClick(fakeCtx(), fakeClick());

    assert.equal(successCalls.length, 1, 'expected the wall-split success toast');
    assert.equal(infoCalls.length, 0, 'expected no skipped-openings notice when skipped === 0');
  });
});
