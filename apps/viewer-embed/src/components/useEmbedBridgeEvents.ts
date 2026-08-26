/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The embed's outbound "store changed -> tell the host" subscriptions.
 *
 * Extracted verbatim from `EmbedViewer.tsx` — a pure move, no behaviour
 * change. These four effects are one concern (turn a store mutation into an
 * outbound bridge event), and `EmbedViewer.test.ts` already exercises them
 * through the real component, so the move is verifiable rather than hopeful.
 * Splitting them out is also what makes room in `EmbedViewer.tsx` (which sat
 * exactly on its module-size budget) for the URL-parameter wiring of #2934.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { emitEvent } from '../bridge/handler.js';

/** Minimum spacing between two outbound CAMERA_CHANGED events (10Hz). */
const CAMERA_EMIT_INTERVAL_MS = 100;

type CameraRotationLike = { azimuth: number; elevation: number };

export function useEmbedBridgeEvents(): void {
  // Emit selection events to parent
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  useEffect(() => {
    if (selectedEntityId !== null) {
      // Resolve metadata for the selected entity
      const state = useViewerStore.getState();
      const lookup = state.resolveGlobalIdFromModels(selectedEntityId);
      const model = lookup ? state.models.get(lookup.modelId) : undefined;
      const entities = model?.ifcDataStore?.entities;
      emitEvent('ENTITY_SELECTED', {
        id: selectedEntityId,
        globalId: entities?.getGlobalId(lookup?.expressId ?? selectedEntityId) ?? undefined,
        modelId: lookup?.modelId,
        ifcType: entities?.getTypeName(lookup?.expressId ?? selectedEntityId) ?? undefined,
      });
    } else {
      emitEvent('ENTITY_DESELECTED', undefined);
    }
  }, [selectedEntityId]);

  // Emit hover events to parent. ENTITY_HOVERED is declared in the protocol
  // and exposed by the SDK, but nothing in this app ever emitted it — the
  // SDK's tests pass because they fabricate the event themselves (#2934).
  //
  // Subscribes to `hoverState.entityId` specifically, not the whole
  // `hoverState` object: screenX/screenY/worldXYZ change on every
  // hover-throttled mousemove even while the pointer stays on the same mesh,
  // so selecting the object would re-post the event continuously instead of
  // only on a hover-target change. The protocol declares no ENTITY_UNHOVERED
  // counterpart to ENTITY_DESELECTED, so null (nothing hovered) is tracked but
  // never emitted.
  const hoveredEntityId = useViewerStore((s) => s.hoverState.entityId);
  useEffect(() => {
    if (hoveredEntityId === null) return;

    const state = useViewerStore.getState();
    const lookup = state.resolveGlobalIdFromModels(hoveredEntityId);
    const model = lookup ? state.models.get(lookup.modelId) : undefined;
    const entities = model?.ifcDataStore?.entities;
    emitEvent('ENTITY_HOVERED', {
      id: hoveredEntityId,
      globalId: entities?.getGlobalId(lookup?.expressId ?? hoveredEntityId) ?? undefined,
      ifcType: entities?.getTypeName(lookup?.expressId ?? hoveredEntityId) ?? undefined,
    });
  }, [hoveredEntityId]);

  // Emit camera rotation changes to parent.
  //
  // Cadence contract: at most one CAMERA_CHANGED per CAMERA_EMIT_INTERVAL_MS
  // (10Hz) while the camera keeps moving, plus exactly one trailing event
  // carrying the pose the camera settled on. Never two events for the same
  // pose.
  //
  // Why not just subscribe to the store's `cameraRotation`: only
  // `setCameraRotation` writes it, and real navigation — orbit/pan drag
  // (useMouseControls.ts), keyboard (useKeyboardControls.ts), the ViewCube and
  // the animation loop (useAnimationLoop.ts) — deliberately bypasses store
  // state for performance and reports through `updateCameraRotationRealtime`.
  // So the store subscription could only ever echo a pose the host itself had
  // just sent, and a host watching a live drag heard nothing (#2934 item 2).
  //
  // Why not emit on every `updateCameraRotationRealtime`: that feed is
  // per-animation-frame while anything is moving AND a ~2Hz heartbeat while
  // the camera is perfectly still (useAnimationLoop.ts re-reports every 500ms
  // when idle). Hence both the throttle and the equality check — an unchanged
  // pose is not a change and must not be posted.
  //
  // The previous throttle *dropped* anything arriving inside the window
  // instead of deferring it, so the last pose of a gesture — the one the host
  // actually needs — was the one most likely to be lost. The trailing flush
  // below is what replaces that dropped event; the old leading-edge emit is
  // still the first branch here, and the mount-time emit of the initial pose
  // still happens. The ONE case the old code posted and this does not: a
  // `setCameraRotation` writing the pose already emitted, which used to
  // re-post an identical CAMERA_CHANGED. That is the deliberate half of the
  // change -- with the realtime feed now wired in, an unchanged pose would
  // arrive as a heartbeat rather than as news.
  const subscribeCameraRotation = useViewerStore((s) => s.subscribeCameraRotation);
  const storeCameraRotation = useViewerStore((s) => s.cameraRotation);
  const reportCamera = useRef<(rotation: CameraRotationLike) => void>(() => {});
  useEffect(() => {
    let lastEmitAt = 0;
    let lastSent: CameraRotationLike | null = null;
    let pending: CameraRotationLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      const next = pending;
      pending = null;
      if (!next) return;
      // Re-check against what was actually SENT, not only against what was
      // queued. `report` compares an incoming pose to the pending one, so a
      // camera that moves away and returns to the last-emitted pose inside a
      // single window queues the return as news -- and the host would hear the
      // same pose twice in a row, with the intermediate pose it never received
      // in between. The cadence contract is "never two events for the same
      // pose"; this is the only place left that can see it.
      if (lastSent && lastSent.azimuth === next.azimuth && lastSent.elevation === next.elevation) {
        return;
      }
      lastEmitAt = Date.now();
      lastSent = next;
      emitEvent('CAMERA_CHANGED', { azimuth: next.azimuth, elevation: next.elevation });
    };

    const report = (rotation: CameraRotationLike) => {
      const previous = pending ?? lastSent;
      if (previous && previous.azimuth === rotation.azimuth && previous.elevation === rotation.elevation) {
        return;
      }
      pending = { azimuth: rotation.azimuth, elevation: rotation.elevation };
      const waited = Date.now() - lastEmitAt;
      if (waited >= CAMERA_EMIT_INTERVAL_MS) {
        if (timer !== null) clearTimeout(timer);
        flush();
      } else if (timer === null) {
        timer = setTimeout(flush, CAMERA_EMIT_INTERVAL_MS - waited);
      }
    };

    reportCamera.current = report;
    report(useViewerStore.getState().cameraRotation);
    const unsubscribe = subscribeCameraRotation(report);
    return () => {
      unsubscribe();
      reportCamera.current = () => {};
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    };
  }, [subscribeCameraRotation]);

  // The programmatic path. `setCameraRotation` actuates the renderer, but
  // whether that actuation round-trips back through the realtime feed depends
  // on a renderer being registered at all, so SET_CAMERA is reported here too
  // -- through the SAME throttle, whose equality check collapses the duplicate
  // if the realtime feed does echo it back.
  useEffect(() => {
    reportCamera.current(storeCameraRotation);
  }, [storeCameraRotation]);

  // Emit section-plane changes to parent. Mirrors the CAMERA_CHANGED effect
  // above: the bridge's SET_SECTION handler (apps/viewer-embed/src/bridge/
  // handler.ts) only mutates `sectionPlane` via the store's setters and never
  // emits an event itself, so this reactive subscription is what turns those
  // mutations (from SET_SECTION *or* any in-viewer section-tool interaction)
  // into the outbound SECTION_CHANGED event -- same source of truth as
  // ENTITY_SELECTED/CAMERA_CHANGED, not a handler.ts-local special case.
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  useEffect(() => {
    emitEvent('SECTION_CHANGED', {
      axis: sectionPlane.axis,
      position: sectionPlane.position,
      enabled: sectionPlane.enabled,
    });
  }, [sectionPlane]);
}
