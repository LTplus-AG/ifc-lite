/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The snap HUD (#6232 WP3): every running modeling command shows what the
 * pointer snapped to. Driven end to end: a real `wall.place` session, the
 * real command pointer and solver, and the command scene slot that
 * `TOOL_HUD.command` mounts — so the glyph proves the wiring, not a prop.
 * The fake camera maps render (x, z) straight to screen px ×100.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { cleanup } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { getCommandRuntime } from '@/lib/commands/modeling/runtime';
import { solveSnap } from '@/lib/snap/solve';
import { MODELING_SNAP_PROFILE } from '@/lib/snap/rank';
import { createLineworkSource } from '@/lib/snap/sources/linework';
import { renderScene } from '../../../viewport-ui/scene/test/scene-test-support.js';
import { routeCommandPointer } from '../../commandPointer.js';
import type { MouseHandlerContext } from '../../mouseHandlerTypes.js';
import { CommandScene } from './CommandHud.js';
import { SnapHud } from './SnapHud.js';

const NO_LOCK = { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: false, isCorner: false, cornerValence: 0 };

function fakeCtx(): MouseHandlerContext {
  const canvas = { width: 1000, height: 1000, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }) };
  return {
    renderer: {
      getCamera: () => ({ unprojectToRay: (sx: number, sy: number) => ({ origin: { x: sx / 100, y: 20, z: sy / 100 }, direction: { x: 0, y: -1, z: 0 } }) }),
      getCanvas: () => canvas,
      raycastScene: () => null,
      raycastSceneMagnetic: () => ({ snapTarget: null, intersection: null, edgeLock: NO_LOCK }),
    },
    getPickOptions: () => ({ isStreaming: false, hiddenIds: new Set<number>(), isolatedIds: null }),
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, lockStrength: 0 } },
    snapEnabledRef: { current: true },
    setSnapTarget: () => {},
    setEdgeLock: () => {},
    clearEdgeLock: () => {},
    measureRaycastPendingRef: { current: false },
    measureRaycastFrameRef: { current: null },
  } as unknown as MouseHandlerContext;
}

function withCamera(): void {
  const s = useViewerStore.getState();
  useViewerStore.setState({
    cameraCallbacks: { ...s.cameraCallbacks, projectToScreen: (p: { x: number; z: number }) => ({ x: p.x * 100, y: p.z * 100 }) },
  } as Partial<ReturnType<typeof useViewerStore.getState>>);
}

const glyphKind = (root: ParentNode) =>
  root.querySelector('[data-scene-primitive="snap-glyph"]')?.getAttribute('data-snap-kind') ?? null;

beforeEach(async () => {
  await seedModelingSession();
  withCamera();
  const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
  assert.ok('expressId' in wall);
  useViewerStore.getState().startCommand('wall.place');
});
afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
});

describe('SnapHud in the command scene (#6232 WP3)', () => {
  it('wall.place snapped to a wall end shows the endpoint glyph on the end', () => {
    routeCommandPointer(fakeCtx(), 'down', 404, -3);
    assert.equal(getCommandRuntime().snap?.winner?.kind, 'endpoint', 'precondition: the solver snapped to the end');
    const { container, flush } = renderScene(<CommandScene />);
    flush();
    assert.equal(glyphKind(container), 'endpoint');
    const g = container.querySelector('[data-scene-primitive="snap-glyph"]') as SVGGElement;
    // The fake camera maps render (x, z) ×100 → px: the end is render (4, 0, 0).
    assert.equal(g.getAttribute('transform'), 'translate(400 0)');
  });

  it('shows nothing when the cursor snapped to nothing', () => {
    routeCommandPointer(fakeCtx(), 'down', 1000, -1000);
    assert.equal(getCommandRuntime().snap?.winner, null);
    const { container, flush } = renderScene(<CommandScene />);
    flush();
    assert.equal(glyphKind(container), null);
  });

  it('draws an extension as a dashed guide from the nearer wall end through the point', () => {
    const plane = getCommandRuntime().ctx!.workplane!;
    const src = createLineworkSource({ segments: [[[0, 0], [4, 0]]], inference: true });
    const snap = solveSnap(
      { cursor: [7, 0.03], metresPerPixel: 0.01, anchor: null, chain: [], modifiers: { shift: false, alt: false }, locks: {} },
      [src], { ...MODELING_SNAP_PROFILE, sources: ['linework'] },
    );
    assert.equal(snap.winner?.kind, 'extension');
    const { container, flush } = renderScene(<SnapHud snap={snap} plane={plane} />);
    flush();
    assert.equal(glyphKind(container), 'extension');
    const lines = [...container.querySelectorAll('[data-snap-guide="extension"] > g > line:last-child')] as SVGLineElement[];
    assert.equal(lines.length, 2, 'the guide breaks around the glyph: wall end → glyph, glyph → overshoot');
    const [before, after] = lines;
    assert.equal(before.getAttribute('stroke-dasharray'), '5 4');
    // From the wall end at x = 4 m (not its start at 0) up to the glyph gap at 7 m, then on past it.
    assert.equal(+before.getAttribute('x1')!, 400);
    assert.equal(+before.getAttribute('x2')!, 700 - 8);
    assert.equal(+after.getAttribute('x1')!, 700 + 8);
    assert.ok(+after.getAttribute('x2')! > 708);
    for (const l of lines) assert.equal(+l.getAttribute('y1')!, 0);
  });
});
