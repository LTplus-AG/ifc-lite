/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mount a three.js scene from a React effect without taking the page down
 * when the device refuses a WebGL context (issue #2401).
 *
 * One hook for both `/mcp` three.js surfaces, so the guard, the session latch
 * and the single report live in exactly one place. Each caller keeps its own
 * fallback UI — a decorative hero and a working playground viewer degrade to
 * different things — but none of them re-implements the decision.
 *
 * The seam is the same one `LocationMap.tsx` uses for MapLibre: probe, guard,
 * degrade, and report ONCE per session as a HANDLED exception. The handled
 * capture is the point of the reporting change, not a detail: before this, the
 * throw escaped into `ChunkErrorBoundary`, which reported it under
 * `lazy_subtree_boundary` — the bucket for "a real bug crashed a page". It is
 * no longer a crashed page, so it no longer reports as one. It is still
 * reported, because a device that cannot run the hero is worth knowing about.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { posthog } from '@/lib/analytics';
import {
  startThreeScene,
  getThreeWebglVerdict,
  takeThreeWebglReportSlot,
  describeThreeWebglFailure,
  type ThreeSurface,
  type ThreeWebglFailureReason,
} from './three-webgl-support';

/** Everything the hook needs to be able to tear a scene down. */
interface DisposableScene {
  dispose(): void;
}

export interface ThreeSceneMount<Handle extends DisposableScene> {
  /** Attach to the element the scene should render into. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** The live scene, or `null` before mount and whenever WebGL is unavailable. */
  handleRef: RefObject<Handle | null>;
  /** Non-null once the scene has been given up on. Drives the caller's fallback. */
  unavailable: ThreeWebglFailureReason | null;
}

/**
 * @param surface     Which `/mcp` surface this is — reported, so the two can be
 *                    told apart on the dashboard.
 * @param create      Builds the scene into the container. Called at most once
 *                    per mount, and never on a device already known to refuse.
 * @param onMounted   Optional per-mount side effect (an animation loop, a
 *                    subscription). Its returned cleanup runs BEFORE
 *                    `handle.dispose()`, so a running rAF can be cancelled
 *                    before the renderer it draws with goes away.
 */
export function useThreeScene<Handle extends DisposableScene>(
  surface: ThreeSurface,
  create: (container: HTMLElement) => Handle,
  onMounted?: (handle: Handle) => (() => void) | void,
): ThreeSceneMount<Handle> {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<Handle | null>(null);

  // Read through refs so the mount effect can stay `[]`-dependent (the scene is
  // built once per mount by design) without capturing a stale closure.
  const createRef = useRef(create);
  createRef.current = create;
  const onMountedRef = useRef(onMounted);
  onMountedRef.current = onMounted;

  // Seeded from the session latch, so a remount on a device already known to
  // refuse WebGL paints the fallback immediately — no probe, no construction,
  // no frame of dead canvas.
  const [unavailable, setUnavailable] = useState<ThreeWebglFailureReason | null>(() => {
    const verdict = getThreeWebglVerdict();
    return verdict && !verdict.supported ? verdict.reason ?? 'probe_no_context' : null;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const started = startThreeScene<Handle>(container, (el) => createRef.current(el));
    if (!started.ok) {
      // Nothing to purge: three builds its own detached canvas and our two
      // `createScene` factories only append it AFTER the renderer exists, so a
      // refused context leaves the container untouched. (MapLibre needs
      // `purgeMapContainer` because its constructor mutates ours first.)
      setUnavailable(started.reason);
      reportThreeWebglDegradation(surface, started.reason, started.error);
      return;
    }

    const handle = started.handle;
    handleRef.current = handle;
    const stop = onMountedRef.current?.(handle);
    return () => {
      stop?.();
      handle.dispose();
      handleRef.current = null;
    };
  }, [surface]);

  return { containerRef, handleRef, unavailable };
}

/**
 * The properties this degradation is filed under.
 *
 * `context` is what changes the classification: the same throw used to arrive
 * as `lazy_subtree_boundary` (a page-killing bug) and now arrives as a scoped,
 * handled degradation of one panel.
 *
 * Every key here has to survive the analytics scrub (`lib/analytics-scrub.ts`),
 * which DELETES any key containing name / filename / model / title / label /
 * path / url / email / comment / query / psetname — a property named
 * `three_label` would silently vanish and the event would say nothing about
 * which surface died. All values are fixed enum strings describing the GPU and
 * the surface, never user or model data. Exported so a test can push them
 * through the real scrub rather than trusting that reading (#2401).
 */
export function threeWebglReportProperties(
  surface: ThreeSurface,
  reason: ThreeWebglFailureReason,
  error: unknown,
): Record<string, string> {
  return {
    context: 'mcp_three_webgl',
    three_surface: surface,
    three_unavailable_reason: reason,
    ...describeThreeWebglFailure(error),
  };
}

/**
 * Report the degradation once per session.
 *
 * `error` is absent when the session latch already knew — a remount is not new
 * information, and a device where the user keeps re-opening the playground
 * panel would otherwise flood the exception quota.
 */
function reportThreeWebglDegradation(
  surface: ThreeSurface,
  reason: ThreeWebglFailureReason,
  error: unknown,
): void {
  if (error === undefined) return;
  if (!takeThreeWebglReportSlot()) return;
  posthog.captureException(error, threeWebglReportProperties(surface, reason, error));
}
