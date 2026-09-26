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

  useEffect(() => {
    // `useWebGPU`'s adapter probe is async; wait for it to settle so the
    // guard below gets a definitive answer instead of racing it (the effect
    // re-runs once `webgpu.checking` flips).
    if (webgpu.checking) return;
    if (autoloadDoneRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const modelUrl = params.get('model');
    if (!modelUrl) return;
    autoloadDoneRef.current = true;

    const fail = (key: TranslationKey, code: string, values?: Record<string, string>) =>
      showLoadError(useViewerStore.getState().setError, t(key, values), code);

    const attempt = async () => {
      if (!guardWebGpu(() => { void attempt(); })) return;
      // Resolve (supports relative paths) and enforce same-origin before fetching.
      let resolvedUrl: URL;
      try {
        resolvedUrl = new URL(modelUrl, window.location.href);
      } catch {
        fail('viewportLighting.container.modelUrlAutoload.malformedUrl', 'model_url_malformed');
        return;
      }
      if (resolvedUrl.origin !== window.location.origin) {
        fail('viewportLighting.container.modelUrlAutoload.crossOrigin', 'model_url_cross_origin');
        return;
      }
      useViewerStore.getState().setLastLoadRetry(() => { void attempt(); });
      try {
        const res = await fetch(resolvedUrl.href);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const blob = await res.blob();
        const filename = resolvedUrl.pathname.split('/').pop() || 'model.ifc';
        const file = new File([blob], filename, { type: blob.type || 'application/x-step' });
        await addModel(file);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        fail('viewportLighting.container.modelUrlAutoload.fetchFailed', 'model_url_fetch_failed', { reason });
      }
    };

    void attempt();
  }, [addModel, guardWebGpu, t, webgpu.checking]);
}
