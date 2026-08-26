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

  // Emit camera rotation changes to parent (throttled)
  const cameraRotation = useViewerStore((s) => s.cameraRotation);
  const lastCameraEmit = useRef(0);
  useEffect(() => {
    const now = Date.now();
    if (now - lastCameraEmit.current < 100) return; // throttle to 10Hz
    lastCameraEmit.current = now;
    emitEvent('CAMERA_CHANGED', {
      azimuth: cameraRotation.azimuth,
      elevation: cameraRotation.elevation,
    });
  }, [cameraRotation]);

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
