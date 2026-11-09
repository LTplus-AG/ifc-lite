/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { useIfcLoader } from '@/hooks/useIfcLoader';
import { useViewerStore } from '@/store';
import { sanitizeFilename } from '@/lib/export/download';
import { pullHandoff } from '@/lib/registry/handoff-client';
import { RegistryError } from '@/lib/registry/protocol';
import { useHandoffWorkspace } from '@/lib/registry/handoff-workspace';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
/** Digest-verified IFC data enters the same load path as every other model. */
export function RegistryLaunchLoader() {
  const { t } = useTranslation(), { loadFile } = useIfcLoader();
  const loader = useRef(loadFile); loader.current = loadFile;
  const [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      setBusy(true); setError('');
      void (async () => {
        const { handoff, sourceSession } = useHandoffWorkspace.getState();
        if (!handoff || !sourceSession) throw new RegistryError('Open the selected version again to authorize access.');
        const received = await pullHandoff(handoff.source, sourceSession, controller.signal);
        controller.signal.throwIfAborted();
        const modelId = crypto.randomUUID();
        await loader.current(new File([received.bytes], sanitizeFilename(received.filename, { fallback: 'model.ifc' }), { type: 'application/x-step' }), { kind: 'primary', modelId });
        controller.signal.throwIfAborted();
        const state = useViewerStore.getState(), loaded = state.models.get(modelId);
        if (state.error || loaded?.loadError || loaded?.loadState !== 'complete' || !loaded.ifcDataStore || state.activeModelId !== modelId) throw new RegistryError(loaded?.loadError || state.error || 'The selected model could not be opened.');
        useHandoffWorkspace.setState({ loadedModelId: modelId });
        state.setEditEnabled(handoff.intent === 'edit'); state.setSourcesPanelVisible(true);
      })().catch((failure: unknown) => { if (!disposed) setError(failure instanceof Error ? failure.message : 'Open the selected version again.'); })
        .finally(() => { if (!disposed) setBusy(false); });
    });
    return () => { disposed = true; controller.abort(); };
  }, [attempt]);
  if (!busy && !error) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-6"><div className="max-w-md space-y-3 rounded-lg border bg-background p-6">
    {busy && <output>{t('registry.launch.loading')}</output>}{error && <><p role="alert" className="text-sm text-destructive">{error}</p><Button onClick={() => setAttempt(n => n + 1)}>{t('registry.launch.retry')}</Button></>}
  </div></div>;
}
