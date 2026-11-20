/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { prepareNativeAppearanceReference, placeNativeAppearanceReference, ReferenceAppearanceError } from '@/lib/appearance/appearance-native-reference';

import { useAsyncRun } from '@/hooks/useAsyncRun';
import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import { placementFrameKey } from '@/lib/model-placement/persistence.js';
import type { RegisteredAppearanceReference } from '@/lib/appearance/references/types.js';
import type { AppearanceSourceOption } from '@/lib/appearance/draft-types.js';
import type { AppearancePanelViewProps } from './types.js';
import { rawMessage, translatedMessage, type LocalizedMessage } from './localized-message.js';

import { referenceEditSettings, restoreReferenceSource } from '@/lib/appearance/references/edit.js';

type Preview = { record: RegisteredAppearanceReference; source: AppearanceSourceOption; bitmap: ImageBitmap; signal: AbortSignal };
const referenceErrorMessage = (error: unknown): LocalizedMessage => error instanceof ReferenceAppearanceError
  ? translatedMessage(error.translationKey) : rawMessage(error);

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
  const [message, setMessage] = useState<LocalizedMessage>(() => translatedMessage('appearance.reference.chooseSource'));
  const placeRun = useAsyncRun();
  const draftId = useRef(`appearance-draft:${crypto.randomUUID()}`).current;
  const draft = useRef<Preview | null>(null);
  const settings = base.settings;
  useEffect(() => { setActive(enabled); }, [enabled, source, settings]);

  useEffect(() => {
    const renderer = getGlobalRenderer();
    if (!enabled || !active) return;
    if (roomId) {
      setStatus('idle'); setMessage(translatedMessage('appearance.reference.leaveRoom'));
      return;
    }
    if (base.sourceBusy) return;
    if (editing && useViewerStore.getState().appearanceReferences.get(editing.id) !== editing) {
      setStatus('stale'); setMessage(translatedMessage('appearance.reference.drawingChanged')); return;
    }
    if (!source?.calibration) { setStatus('idle'); setMessage(translatedMessage('appearance.reference.calibrate')); return; }
    if (!renderer) { setStatus('idle'); setMessage(translatedMessage('appearance.reference.waitForView')); return; }
    const controller = new AbortController();
    const owner = { kind: 'draft' as const, id: crypto.randomUUID() };
    setStatus('preparing'); setMessage(translatedMessage('appearance.reference.preparing'));
    let inFlight = false;
    const timer = setTimeout(() => { inFlight = true; void (async () => {
      try {
        const {record,bitmap,corners} = await prepareNativeAppearanceReference(source,settings,frameKey,editing,owner,controller.signal);
        await renderer.getReferenceImages().set({ ...record, id: draftId, corners, bitmap }, controller.signal);
        controller.signal.throwIfAborted();
        draft.current = { record, source, bitmap, signal: controller.signal };
        setStatus('ready'); setMessage(translatedMessage('appearance.reference.ready'));
      } catch (error) {
        if (!controller.signal.aborted) {
          renderer.getReferenceImages().remove(draftId);
          appearanceAssets.releaseOwner(owner);
          setStatus('error'); setMessage(referenceErrorMessage(error));
        }
      } finally {
        inFlight = false;
        if (controller.signal.aborted) appearanceAssets.releaseOwner(owner);
      }
    })(); }, 150);
    return () => {
      placeRun.reset(); clearTimeout(timer); controller.abort(); draft.current = null;
      renderer.getReferenceImages().remove(draftId);
      if (!inFlight) appearanceAssets.releaseOwner(owner);
    };
  }, [enabled, active, source, settings, frameKey, base.sourceBusy, roomId, draftId, editing, placeRun.reset]);

  async function place(): Promise<void> {
    const prepared = draft.current, renderer = getGlobalRenderer();
    if (!prepared || !renderer) return;
    await placeRun.start(async ({ signal: runSignal }) => {
      const { record } = prepared;
      const signal = AbortSignal.any([prepared.signal, runSignal]);
      setMessage(translatedMessage('appearance.reference.placing'));
      try {
        await placeNativeAppearanceReference(prepared,renderer,signal,editing);
        setActive(false); setEditing(null); setStatus('idle'); setMessage(translatedMessage(editing
          ? 'appearance.reference.saved' : 'appearance.reference.placed'));
      } catch (error) {
        if (!useViewerStore.getState().appearanceReferences.has(record.id)) renderer.getReferenceImages().remove(record.id);
        if (!signal.aborted) { setStatus('error'); setMessage(referenceErrorMessage(error)); }
      }
    });
  }
  function edit(id: string): void {
    try {
      const record = useViewerStore.getState().appearanceReferences.get(id);
      if (!record) throw new ReferenceAppearanceError('appearance.reference.drawingRemoved');
      const restoredSettings = referenceEditSettings(record);
      const restoredSource = restoreReferenceSource(record);
      base.onDiscard();
      base.onSourceChange(restoredSource.id);
      base.onSettingsChange(restoredSettings);
      setEditing(record); setEditRevision(value => value + 1); setActive(true);
    } catch (error) { setStatus('error'); setMessage(referenceErrorMessage(error)); }
  }
  if (!enabled) return base;
  return { ...base, status: placeRun.busy ? 'applying' : status, statusMessage: message, onEditReference: edit, editingReference: !!editing,
    calibration: base.calibration ? { ...base.calibration, sourceKey: `${base.calibration.sourceKey}:${editRevision}` } : undefined,
    unavailableReason: roomId ? translatedMessage('appearance.reference.leaveRoom') : undefined,
    canApply: !placeRun.busy && status === 'ready' && !!draft.current, hasPreview: !!draft.current,
    canDiscard: base.canDiscard || active, showingOriginal: false,
    onDiscard: () => { placeRun.reset(); base.onDiscard(); setEditing(null); setActive(false); setStatus('idle'); setMessage(translatedMessage('appearance.reference.discarded')); },
    onApply: () => { void place(); },
  };
}
