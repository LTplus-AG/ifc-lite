/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Auto-load a model from `?model=<URL>` (used by the landing-page iframe to
 * drop a sample IFC into the viewer on first mount). Extracted from
 * `ViewerLayout.tsx` (#5851): a malformed URL, a cross-origin URL and a
 * failed fetch used to end in `console.error` only, so the user saw an empty
 * viewer with no explanation. Each now reports through the shared
 * `showLoadError` helper, so the in-viewport load-error card shows it, with
 * Retry re-running this same attempt.
 *
 * SECURITY: only SAME-ORIGIN model URLs are fetched. `?model=` is fully
 * attacker-controllable (any link can set it), so honouring an arbitrary
 * cross-origin URL is a drive-by model-injection vector. We resolve the
 * param against the current document and require its origin to match
 * `window.location.origin`; a cross-origin URL is refused, never fetched.
 */

import { useEffect, useRef } from 'react';
import { useIfc } from './useIfc';
import { useWebGpuOpenGuard } from './useWebGpuOpenGuard';
import { showLoadError } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { useTranslation, type TranslationKey } from '@/i18n';

export function useModelUrlAutoload(): void {
  const { addModel } = useIfc();
  const { webgpu, guard: guardWebGpu } = useWebGpuOpenGuard();
  const { t } = useTranslation();
  const autoloadDoneRef = useRef(false);
  // Navigation may change the query and relative URL base while the adapter
  // probe is pending. Preserve the source requested on this mount.
  const sourceRef = useRef<{ modelUrl: string | null; baseUrl: string } | null>(null);
  if (sourceRef.current === null) {
    sourceRef.current = {
      modelUrl: new URLSearchParams(window.location.search).get('model'),
      baseUrl: window.location.href,
    };
  }

  useEffect(() => {
    // `useWebGPU`'s adapter probe is async; wait for it to settle so the
    // guard below gets a definitive answer instead of racing it (the effect
    // re-runs once `webgpu.checking` flips).
    if (webgpu.checking) return;
    if (autoloadDoneRef.current) return;
    const source = sourceRef.current;
    if (!source) return;
    const { modelUrl, baseUrl: sourceBaseUrl } = source;
    if (!modelUrl) return;
    autoloadDoneRef.current = true;

    // `retry` is required at every call (#5851 review): a malformed or
    // cross-origin URL is the SAME url string on every attempt, so retrying
    // it can never differ — null, no Retry button. A fetch failure may well
    // be transient, so it gets a real retry over this same attempt.
    const fail = (key: TranslationKey, code: string, retry: (() => void) | null, values?: Record<string, string>) => {
      const { setError, setLastLoadRetry } = useViewerStore.getState();
      showLoadError(setError, setLastLoadRetry, t(key, values), code, retry);
    };

    let resolvedUrl: URL | null = null;
    const attempt = async () => {
      if (!guardWebGpu(() => { void attempt(); })) return;
      // Resolve (supports relative paths) and enforce same-origin before fetching.
      let source: URL;
      try {
        source = resolvedUrl ?? new URL(modelUrl, sourceBaseUrl);
        resolvedUrl = source;
      } catch {
        fail('viewportLighting.container.modelUrlAutoload.malformedUrl', 'model_url_malformed', null);
        return;
      }
      if (source.origin !== window.location.origin) {
        fail('viewportLighting.container.modelUrlAutoload.crossOrigin', 'model_url_cross_origin', null);
        return;
      }
      try {
        const res = await fetch(source.href);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const blob = await res.blob();
        const filename = source.pathname.split('/').pop() || 'model.ifc';
        const file = new File([blob], filename, { type: blob.type || 'application/x-step' });
        await addModel(file);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        fail('viewportLighting.container.modelUrlAutoload.fetchFailed', 'model_url_fetch_failed',
          () => { void attempt(); }, { reason });
      }
    };

    void attempt();
  }, [addModel, guardWebGpu, t, webgpu.checking]);
}
