/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import type { FileSourceProviderFactory } from '@/services/sources/source-host';
import { ViewerRoot } from '@/components/viewer/ViewerRoot';
import { registerEnglish, useTranslation } from '@/i18n';
import { registryEn } from '@/i18n/catalogues/registry.en';
import { finishHandoff, prepareHandoff } from '@/lib/registry/handoff-auth';
import { HANDOFF_CALLBACK, HANDOFF_PATH } from '@/lib/registry/handoff-contract';
import { useHandoffWorkspace } from '@/lib/registry/handoff-workspace';
import { RegistryLaunchLoader } from './RegistryLaunchLoader';
import { registryLaunchLocation, clearRegistryLaunchLocation } from '@/registry-launch-location';
registerEnglish(registryEn);
/** A handoff is a locator; the application obtains its own OAuth access before loading content. */
export default function RegistryLaunchRoute({ sourceProviders, enabled = import.meta.env?.VITE_REGISTRY_ENABLED === 'true' }: {
  sourceProviders?: readonly FileSourceProviderFactory[]; enabled?: boolean;
}) {
  const { t } = useTranslation(), [href] = useState(registryLaunchLocation);
  const callback = new URL(href).pathname === HANDOFF_CALLBACK;
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(enabled), [error, setError] = useState('');
  const translate = useRef(t); translate.current = t;
  useEffect(() => {
    window.history.replaceState(null, '', HANDOFF_PATH); clearRegistryLaunchLocation();
    const controller = new AbortController(); let disposed = false;
    const timer = setTimeout(() => controller.abort(), 30000);
    queueMicrotask(() => {
      if (disposed || !enabled) return;
      const opening = callback ? finishHandoff(href, controller.signal).then(({ handoff, session }) => {
        if (!disposed) { useHandoffWorkspace.setState({ handoff, sourceSession: session, loadedModelId: undefined }); setReady(true); }
      }) : prepareHandoff(href, controller.signal).then(url => { controller.signal.throwIfAborted(); window.location.assign(url); });
      void opening.catch((failure: unknown) => { if (!disposed) setError(failure instanceof Error ? failure.message : translate.current('registry.failed')); })
        .finally(() => { clearTimeout(timer); if (!disposed) setBusy(false); });
    });
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [callback, enabled, href]);
  if (ready) return <ViewerRoot sourceProviders={sourceProviders}><RegistryLaunchLoader /></ViewerRoot>;
  return <main className="flex min-h-screen items-center justify-center bg-background p-6"><div className="max-w-md space-y-4 rounded-lg border p-6">
    <h1 className="text-xl font-semibold">{t('registry.launch.title')}</h1>
    <p className="text-sm">{t(enabled ? 'registry.handoff.explain' : 'registry.launch.disabled')}</p>
    {busy && <output>{t('registry.working')}</output>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <a className="text-sm underline" href="/">{t('registry.launch.viewer')}</a>
  </div></main>;
}
