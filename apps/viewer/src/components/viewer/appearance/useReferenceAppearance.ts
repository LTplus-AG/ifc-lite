/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import { placementFrameKey } from '@/lib/model-placement/persistence.js';
import { referenceRenderCorners } from '@/lib/appearance/reference-runtime/frame.js';
import { calibrateAppearancePlane, type PlaneCalibrationRequest } from '@/lib/appearance/plane-calibration.js';
import { pdfCalibrationFrame } from '@/lib/appearance/pdf/calibration.js';
import { imageCalibrationFrame } from '@/lib/appearance/raster-calibration.js';
import { appearanceMapping } from '@/lib/appearance/settings.js';
import type { RegisteredAppearanceReference } from '@/lib/appearance/references/types.js';
import type { AppearanceSourceOption } from '@/lib/appearance/draft-types.js';
import type { AppearancePanelViewProps } from './types.js';

import { referenceEditSettings, restoreReferenceSource } from '@/lib/appearance/references/edit.js';

type Preview = { record: RegisteredAppearanceReference; source: AppearanceSourceOption; bitmap: ImageBitmap; signal: AbortSignal };
const normals = { xy: [0, 0, 1], xz: [0, -1, 0], yz: [1, 0, 0] } satisfies Record<string, [number, number, number]>;

/** One transient reference uses the same source and calibration controls as IFC
 * appearance. Only Place publishes a registration and a workspace history entry. */
export function useReferenceAppearance(base: AppearancePanelViewProps, enabled: boolean): AppearancePanelViewProps {
  const source = useViewerStore(state => state.appearanceSources.find(item => item.id === base.sourceId));
  const frameKey = useViewerStore(placementFrameKey);
  const roomId = useViewerStore(state => state.collabRoomId);
  const [editRevision, setEditRevision] = useState(0);
  const [editing, setEditing] = useState<RegisteredAppearanceReference | null>(null);
  const [active, setActive] = useState(true);
  const [status, setStatus] = useState<AppearancePanelViewProps['status']>('idle');
  const [message, setMessage] = useState('Choose a source and calibrate its scale.');
  const draftId = useRef(`appearance-draft:${crypto.randomUUID()}`).current;
  const draft = useRef<Preview | null>(null);
  const settings = base.settings;
  useEffect(() => { setActive(enabled); }, [enabled, source, settings]);

  useEffect(() => {
    const renderer = getGlobalRenderer();
    if (!enabled || !active || base.sourceBusy || roomId) return;
    if (editing && useViewerStore.getState().appearanceReferences.get(editing.id) !== editing) {
      setStatus('stale'); setMessage('This drawing changed. Discard and open Edit again.'); return;
    }
    if (!source?.calibration) { setStatus('idle'); setMessage('Choose two source points and enter their measured distance.'); return; }
    if (!renderer) { setStatus('idle'); setMessage('Wait for the 3D view to be ready.'); return; }
    const controller = new AbortController();
    const owner = { kind: 'draft' as const, id: crypto.randomUUID() };
    setStatus('preparing'); setMessage('Preparing reference…');
    let inFlight = false;
    const timer = setTimeout(() => { inFlight = true; void (async () => {
      try {
        const mapping = appearanceMapping({ ...settings, kind: 'planar' });
        if (mapping.kind !== 'planar') throw new Error('References need planar placement.');
        const calibration: PlaneCalibrationRequest = { ...(source.calibrationFrame ?? (source.pdf ? pdfCalibrationFrame(source.pdf.recipe)
          : imageCalibrationFrame(source.width, source.height))), ...source.calibration!,
          worldAnchor: mapping.origin, worldDirection: mapping.axisU, planeNormal: normals[settings.plane] };
        const result = await calibrateAppearancePlane(calibration);
        controller.signal.throwIfAborted();
        if (result.rasterCorners.length !== 4) throw new Error('The calibrated reference has incomplete corners.');
        const [a, b, c, d] = result.rasterCorners;
        const record: RegisteredAppearanceReference = { id: editing?.id ?? crypto.randomUUID(), sourceId: source.id,
          assetId: source.assetId ?? source.id, cornersIfcWorld: [a, b, c, d], frameKey,
          visible: editing?.visible ?? true, locked: false, opacity: editing?.opacity ?? 1, calibration };
        const corners = referenceRenderCorners(record, useViewerStore.getState());
        if (!corners) throw new Error('The workspace frame changed. Refresh reference placement.');
        appearanceAssets.retain(record.assetId, owner);
        const bitmap = await appearanceAssets.decode(record.assetId, owner, controller.signal);
        await renderer.getReferenceImages().set({ ...record, id: draftId, corners, bitmap }, controller.signal);
        controller.signal.throwIfAborted();
        draft.current = { record, source, bitmap, signal: controller.signal };
        setStatus('ready'); setMessage('Reference ready. Place it in the workspace without changing IFC appearance.');
      } catch (error) {
        if (!controller.signal.aborted) {
          renderer.getReferenceImages().remove(draftId);
          appearanceAssets.releaseOwner(owner);
          setStatus('error'); setMessage(error instanceof Error ? error.message : String(error));
        }
      } finally {
        inFlight = false;
        if (controller.signal.aborted) appearanceAssets.releaseOwner(owner);
      }
    })(); }, 150);
    return () => {
      clearTimeout(timer); controller.abort(); draft.current = null;
      renderer.getReferenceImages().remove(draftId);
      if (!inFlight) appearanceAssets.releaseOwner(owner);
    };
  }, [enabled, active, source, settings, frameKey, base.sourceBusy, roomId, draftId, editing]);

  async function place(): Promise<void> {
    const prepared = draft.current, renderer = getGlobalRenderer();
    if (!prepared || !renderer) return;
    const { record, bitmap, signal } = prepared;
    setStatus('applying'); setMessage('Placing reference…');
    const placementOwner = { kind: 'draft' as const, id: `reference-place:${crypto.randomUUID()}` };
    try {
      appearanceAssets.retain(record.assetId, placementOwner);
      signal.throwIfAborted();
      const corners = referenceRenderCorners(record, useViewerStore.getState());
      if (!corners) throw new Error('The workspace frame changed. Refresh reference placement.');
      // Replacement is published through the committed-record bridge, so the
      // old registered image stays valid until the transaction is accepted.
      if (!editing) await renderer.getReferenceImages().set({ ...record, corners, bitmap }, signal);
      signal.throwIfAborted();
      const state = useViewerStore.getState();
      if (placementFrameKey(state) !== record.frameKey || state.appearanceSources.find(item => item.id === record.sourceId) !== prepared.source) {
        throw new Error('The source or registration changed while placing the reference.');
      }
      if (editing) {
        if (state.appearanceReferences.get(editing.id) !== editing) throw new Error('This drawing changed. Discard and open Edit again.');
        state.replaceAppearanceReference(editing.id, record);
      } else state.addAppearanceReference(record);
      state.selectAppearanceReference(record.id);
      setActive(false); setEditing(null); setStatus('idle'); setMessage(editing ? 'Registration saved. Undo is available.' : 'Reference placed. Undo is available.');
    } catch (error) {
      if (!useViewerStore.getState().appearanceReferences.has(record.id)) renderer.getReferenceImages().remove(record.id);
      if (!signal.aborted) { setStatus('error'); setMessage(error instanceof Error ? error.message : String(error)); }
    } finally { appearanceAssets.releaseOwner(placementOwner); }
  }
  function edit(id: string): void {
    try {
      const record = useViewerStore.getState().appearanceReferences.get(id);
      if (!record) throw new Error('This drawing was removed.');
      const restoredSettings = referenceEditSettings(record);
      const restoredSource = restoreReferenceSource(record);
      base.onDiscard();
      base.onSourceChange(restoredSource.id);
      base.onSettingsChange(restoredSettings);
      setEditing(record); setEditRevision(value => value + 1); setActive(true);
    } catch (error) { setStatus('error'); setMessage(error instanceof Error ? error.message : String(error)); }
  }
  if (!enabled) return base;
  return { ...base, status, statusMessage: message, onEditReference: edit, editingReference: !!editing,
    calibration: base.calibration ? { ...base.calibration, sourceKey: `${base.calibration.sourceKey}:${editRevision}` } : undefined,
    unavailableReason: roomId ? 'Leave the shared room to place drawing references.' : undefined,
    canApply: status === 'ready' && !!draft.current, hasPreview: !!draft.current,
    canDiscard: base.canDiscard || active, showingOriginal: false,
    onDiscard: () => { base.onDiscard(); setEditing(null); setActive(false); setStatus('idle'); setMessage('Reference preview discarded.'); },
    onApply: () => { void place(); },
  };
}
