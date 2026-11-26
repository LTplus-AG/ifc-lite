/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Engine and licences" in the Retained geometry panel (#7955 M2, §2.2/§3.5):
 * the SDK revision and manifest digest of the engine this viewer serves, and
 * links to its served licence files. Fetched only when the user opens it;
 * the manifest's ETag is its sha256 (`vite-plugins/retained-engine.ts`).
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useAsyncRun } from '@/hooks/useAsyncRun';

const ENGINE = '/retained-engine/';
const LICENCES = [
  ['LICENSES/SMLib/LICENSE', 'retainedGeometry.panel.licence.smlib'],
  ['LICENSES/SMLib/THIRD_PARTY_NOTICES.md', 'retainedGeometry.panel.licence.smlibNotices'],
  ['LICENSES/ifc-lite/LICENSE', 'retainedGeometry.panel.licence.ifcLite'],
] as const;

type EngineInfo = { state: 'ready'; revision: string; digest: string } | { state: 'error'; reason: string };

async function readManifest(fetcher: typeof fetch, signal: AbortSignal): Promise<EngineInfo> {
  try {
    const response = await fetcher(`${ENGINE}engine-manifest.json`, { cache: 'no-cache', signal });
    if (!response.ok) return { state: 'error', reason: `HTTP ${response.status}` };
    const manifest = await response.json() as { sdk?: { revision?: unknown } };
    return {
      state: 'ready',
      revision: typeof manifest.sdk?.revision === 'string' ? manifest.sdk.revision : '?',
      digest: (response.headers.get('ETag') ?? '?').replace(/^W\//, '').replaceAll('"', ''),
    };
  } catch (error) {
    return { state: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}

export function RetainedEngineDetails({ fetcher = fetch }: { fetcher?: typeof fetch }) {
  const { t } = useTranslation();
  // Closing resets the run and reopening restarts it, so only the latest open's answer can land (#11447).
  const manifest = useAsyncRun<EngineInfo>({ label: 'retained engine manifest' });
  const open = manifest.state.kind !== 'idle';
  const info = manifest.state.kind === 'succeeded' ? manifest.state.result : null;
  const toggle = () => {
    if (open) manifest.reset();
    else void manifest.restart(({ signal }) => readManifest(fetcher, signal));
  };
  return (
    <div className="min-w-0 text-xs">
      <button type="button" className="inline-flex items-center gap-1 text-sm hover:underline" aria-expanded={open} onClick={toggle}>
        {open ? <ChevronDown aria-hidden className="h-3.5 w-3.5" /> : <ChevronRight aria-hidden className="h-3.5 w-3.5" />}
        {t('retainedGeometry.panel.engine')}
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 pl-5 text-muted-foreground">
          {manifest.busy && <p>{t('retainedGeometry.panel.engineLoading')}</p>}
          {info?.state === 'error' && <p>{t('retainedGeometry.panel.engineUnavailable', { reason: info.reason })}</p>}
          {info?.state === 'ready' && (
            <>
              <p className="font-mono">{t('retainedGeometry.panel.sdkRevision', { revision: info.revision })}</p>
              <p className="break-all font-mono">{t('retainedGeometry.panel.manifestDigest', { digest: info.digest })}</p>
            </>
          )}
          <ul className="flex flex-wrap gap-x-3">
            {LICENCES.map(([path, label]) => (
              <li key={path}><a className="underline" href={`${ENGINE}${path}`} target="_blank" rel="noreferrer">{t(label)}</a></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
