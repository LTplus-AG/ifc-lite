/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Engine and licences" in the Retained geometry panel (#7955 M2, §2.2/§3.5):
 * the SDK revision and manifest digest of the engine this viewer serves, and
 * links to its served licence files. Fetched only when the user opens it;
 * the manifest's ETag is its sha256 (`vite-plugins/retained-engine.ts`).
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/i18n';

const ENGINE = '/retained-engine/';
const LICENCES = [
  ['LICENSES/SMLib/LICENSE', 'retainedGeometry.panel.licence.smlib'],
  ['LICENSES/SMLib/THIRD_PARTY_NOTICES.md', 'retainedGeometry.panel.licence.smlibNotices'],
  ['LICENSES/ifc-lite/LICENSE', 'retainedGeometry.panel.licence.ifcLite'],
] as const;

type EngineInfo = { state: 'loading' } | { state: 'ready'; revision: string; digest: string } | { state: 'error'; reason: string };

async function readManifest(fetcher: typeof fetch): Promise<EngineInfo> {
  try {
    const response = await fetcher(`${ENGINE}engine-manifest.json`, { cache: 'no-cache' });
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
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const toggle = () => {
    if (info) { setInfo(null); return; }
    setInfo({ state: 'loading' });
    void readManifest(fetcher).then(setInfo);
  };
  return (
    <div className="min-w-0 text-xs">
      <button type="button" className="inline-flex items-center gap-1 text-sm hover:underline" aria-expanded={info !== null} onClick={toggle}>
        {info ? <ChevronDown aria-hidden className="h-3.5 w-3.5" /> : <ChevronRight aria-hidden className="h-3.5 w-3.5" />}
        {t('retainedGeometry.panel.engine')}
      </button>
      {info && (
        <div className="mt-1 space-y-0.5 pl-5 text-muted-foreground">
          {info.state === 'loading' && <p>{t('retainedGeometry.panel.engineLoading')}</p>}
          {info.state === 'error' && <p>{t('retainedGeometry.panel.engineUnavailable', { reason: info.reason })}</p>}
          {info.state === 'ready' && (
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
