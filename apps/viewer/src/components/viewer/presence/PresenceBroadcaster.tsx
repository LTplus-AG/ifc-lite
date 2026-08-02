/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Broadcasts this client's live presence (cursor + active tool) over collab
 * awareness so peers can see where you're pointing and what you're doing.
 *
 * Renderless: it locates the viewport canvas (sibling of the overlay layers),
 * throttles mousemove, projects the cursor onto the y=0 world plane via the
 * camera callbacks, and calls `session.presence.setCursor3d` — which is itself
 * throttled to 30 Hz + stale-evicted by the collab runtime. No-op when not in a
 * room. Reads the live session via `getState()` so it never holds a stale ref
 * and never statically imports the (code-split) collab runtime.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { pathForEntity } from '@/lib/collab/mutation-bridge';

/** Cursor plane: most viewer models sit near the local-frame ground (y≈0). */
const CURSOR_PLANE_Y = 0;
/** Cap raycasts to ~33 Hz; presence coalesces the rest. */
const MOVE_THROTTLE_MS = 30;

export function PresenceBroadcaster() {
  const sessionActive = useViewerStore((s) => s.collabSession !== null);
  const anchorRef = useRef<HTMLDivElement>(null);

  // Cursor: throttled mousemove → world point → presence.setCursor3d.
  useEffect(() => {
    if (!sessionActive) return;
    const anchor = anchorRef.current;
    const canvas = anchor?.parentElement?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    let last = 0;
    const onMove = (e: MouseEvent) => {
      const now = e.timeStamp;
      if (now - last < MOVE_THROTTLE_MS) return;
      last = now;
      const { collabSession, cameraCallbacks } = useViewerStore.getState();
      if (!collabSession || !cameraCallbacks.unprojectToFloor) return;
      const world = cameraCallbacks.unprojectToFloor(e.clientX, e.clientY, CURSOR_PLANE_Y);
      // Only update on a successful ground-plane hit; keep the last position
      // otherwise. We deliberately do NOT clear on mouseleave — a peer's cursor
      // should persist at its last spot (it fades when idle, like Figma) so you
      // can see where collaborators are even when their mouse is still or has
      // moved to a panel/another window. It's cleared on leave (teardown below).
      if (world) collabSession.presence.setCursor3d(world);
    };

    canvas.addEventListener('mousemove', onMove);
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      useViewerStore.getState().collabSession?.presence.setCursor3d(null);
    };
  }, [sessionActive]);

  // Tool: mirror the active tool so peer labels read "Anna — measure".
  const activeTool = useViewerStore((s) => s.activeTool);
  useEffect(() => {
    if (!sessionActive) return;
    useViewerStore.getState().collabSession?.presence.setTool(activeTool ?? null);
  }, [sessionActive, activeTool]);

  // Selection: broadcast the selected entities as `/guid` paths so peers can see
  // (and the Room panel can show) what each collaborator has selected.
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  useEffect(() => {
    if (!sessionActive) return;
    const { collabSession, ifcDataStore } = useViewerStore.getState();
    if (!collabSession) return;
    const paths: string[] = [];
    if (ifcDataStore) {
      for (const id of selectedEntityIds) {
        const p = pathForEntity(ifcDataStore, id);
        if (p) paths.push(p);
      }
    }
    collabSession.presence.setSelection(paths);
  }, [sessionActive, selectedEntityIds]);

  // Camera: poll the viewpoint and broadcast on meaningful movement, so peers can
  // "jump to" each other's view. Polling catches orbit/pan (which bypass the
  // store) cheaply; presence coalesces the rest.
  useEffect(() => {
    if (!sessionActive) return;
    let lastKey = '';
    const id = window.setInterval(() => {
      const { collabSession, cameraCallbacks } = useViewerStore.getState();
      if (!collabSession || !cameraCallbacks.getViewpoint) return;
      const vp = cameraCallbacks.getViewpoint();
      if (!vp) return;
      const key =
        `${vp.position.x | 0},${vp.position.y | 0},${vp.position.z | 0}|` +
        `${vp.target.x | 0},${vp.target.y | 0},${vp.target.z | 0}`;
      if (key === lastKey) return;
      lastKey = key;
      collabSession.presence.setCamera({ position: vp.position, target: vp.target, fov: vp.fov });
    }, 250);
    return () => window.clearInterval(id);
  }, [sessionActive]);

  return <div ref={anchorRef} style={{ display: 'none' }} aria-hidden="true" />;
}
