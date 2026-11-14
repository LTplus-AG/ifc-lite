/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Open a model the processing server has already processed, from
 * `?processed=<sha256>&bytes=<source size>&name=<file name>`.
 *
 * For a host that keeps the IFC on its own server: the source file never
 * reaches this browser. The viewer asks the configured server
 * (`VITE_IFC_SERVER_URL`, which may be a same-origin path) to replay the result
 * stored under that hash. `bytes` and `name` are for display and for choosing
 * the streamed or one-shot route; only the hash selects what is opened.
 *
 * The hash is attacker-controllable like any query parameter, and it selects a
 * stored result without granting access to it. Whether this user may read the
 * result is decided by whatever serves the server URL (its token or the proxy
 * in front of it), on every request.
 */

import { useEffect, useRef } from 'react';
import { useIfcLoader } from './useIfcLoader.js';
import { useWebGpuOpenGuard } from './useWebGpuOpenGuard';
import { showLoadError } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { markLoadIntent } from '@/lib/load-intent';
import { normalizeProcessedModelHash } from '@ifc-lite/server-client';

/** The model `?processed=` names, `'malformed'` when the hash is not one, `null` when the parameter is absent. */
export function processedModelFromQuery(search: string): { sha256: string; bytes: number; name: string } | 'malformed' | null {
  const params = new URLSearchParams(search);
  const raw = params.get('processed');
  if (raw === null) return null;
  const sha256 = normalizeProcessedModelHash(raw);
  if (sha256 === null) return 'malformed';
  const bytes = Number(params.get('bytes'));
  return { sha256, bytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0, name: params.get('name') || 'model.ifc' };
}

export function useProcessedModelAutoload(): void {
  const { loadFile } = useIfcLoader();
  const { webgpu, guard: guardWebGpu } = useWebGpuOpenGuard();
  const { t } = useTranslation();
  const doneRef = useRef(false);
  // Navigation may change the query while the adapter probe is pending. Keep what this mount asked for.
  const requestRef = useRef<ReturnType<typeof processedModelFromQuery> | undefined>(undefined);
  if (requestRef.current === undefined) requestRef.current = processedModelFromQuery(window.location.search);

  useEffect(() => {
    // Wait for the async adapter probe, as `?model=` does, so the guard gets a definitive answer.
    if (webgpu.checking || doneRef.current) return;
    const request = requestRef.current;
    if (!request) return;
    doneRef.current = true;
    if (request === 'malformed') {
      // The same string on every attempt: no Retry.
      const { setError, setLastLoadRetry } = useViewerStore.getState();
      showLoadError(setError, setLastLoadRetry, t('viewportLighting.container.processedModelAutoload.malformedLink'), 'processed_model_malformed', null);
      return;
    }
    const { sha256, bytes, name } = request;
    const attempt = () => {
      markLoadIntent();
      // Replay-safe (a request, no user gesture): Retry on the unsupported card may re-run it.
      if (!guardWebGpu(attempt, { replay: 'free' })) return;
      void loadFile(new File([], name), { kind: 'primary' }, { processedModel: { sha256, bytes } });
    };
    attempt();
  }, [guardWebGpu, loadFile, t, webgpu.checking]);
}
