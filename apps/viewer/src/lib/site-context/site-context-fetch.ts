/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Load site context": run the build in its worker, load each category the
 * moment it arrives through the one load path (`addModel` → `loadFile`, the
 * same branch a dropped GLB takes), drape imagery on the terrain when asked,
 * and record everything in the site-context slice.
 *
 * Only ever started by a user click (owner's decision): nothing here runs on
 * model load. A primary load that replaces the scene aborts the run.
 */

import type { SiteContextLayerKind } from '@ifc-lite/site-context';
import { useViewerStore } from '@/store';
import { categoryStatusOf, type SiteContextRadius } from '@/store/slices/siteContextSlice';
import { watchLoadSupersession } from '@/hooks/modelLoadCanceller';
import { buildSiteContextInWorker, SiteContextBuildError } from './site-context-client';
import type { SiteContextCategoryMessage } from './site-context-job';
import { siteContextFileName } from './site-context-glb';
import { siteContextModelName } from './site-context-model';

export type SiteContextAddModel = (file: File, options: { name: string }) => Promise<string | null>;

export interface LoadSiteContextOptions {
  anchorModelId: string;
  centre: { x: number; y: number };
  radius: SiteContextRadius;
  categories: SiteContextLayerKind[];
  imagery: boolean;
  addModel: SiteContextAddModel;
  /** Removes a model through the federation (`useIfc().removeModel`): a reloaded category replaces its previous model. */
  removeModel: (modelId: string) => void;
  /** Injected for tests; defaults to the SWISSIMAGE drape. */
  drapeImagery?: (modelId: string, signal: AbortSignal) => Promise<void>;
}

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

export async function loadSiteContext(options: LoadSiteContextOptions): Promise<void> {
  const store = useViewerStore.getState;
  const abort = new AbortController();
  const supersession = watchLoadSupersession('primary');
  const onSuperseded = () => abort.abort();
  supersession.signal.addEventListener('abort', onSuperseded, { once: true });
  store().beginSiteContextRequest({
    anchorModelId: options.anchorModelId, centre: options.centre, radius: options.radius,
    categories: options.categories, imagery: options.imagery, startedAt: Date.now(),
  }, abort);
  const started = performance.now();
  const drape = options.drapeImagery
    ?? (async (modelId: string, signal: AbortSignal) => (await import('./site-context-imagery')).drapeSiteContextImagery(modelId, signal));

  const loadCategory = async (category: SiteContextCategoryMessage): Promise<void> => {
    if (abort.signal.aborted) return;
    const { kind } = category;
    store().setSiteContextCategory(kind, { issues: category.issues, attribution: category.attribution });
    if (!category.hasGeometry) {
      store().setSiteContextCategory(kind, { status: 'error' });
      return;
    }
    // A category loaded again replaces the earlier one rather than stacking a
    // second copy of the same surface in the same place (z-fighting, doubled
    // attribution rows). Only once the new one has arrived with geometry.
    for (const [previousId, record] of store().siteContextModels) {
      if (record.kind === kind) options.removeModel(previousId);
    }
    const file = new File([category.bytes.slice().buffer], siteContextFileName(kind));
    const modelId = await options.addModel(file, { name: siteContextModelName(kind) });
    if (abort.signal.aborted) return;
    store().setSiteContextCategory(kind, { status: categoryStatusOf(modelId !== null, category.complete), ...(modelId ? { modelId } : {}) });
    if (!modelId || kind !== 'terrain' || !options.imagery) return;
    try {
      await drape(modelId, abort.signal);
    } catch (error) {
      if (isAbort(error)) return;
      console.error('[site-context] imagery drape failed:', error);
      const current = store().siteContextCategories.terrain;
      store().setSiteContextCategory('terrain', {
        status: 'partial',
        issues: [...(current?.issues ?? []), {
          code: 'imagery-failed', severity: 'warning',
          message: `aerial imagery could not be draped: ${error instanceof Error ? error.message : String(error)}`,
        }],
      });
    }
  };

  // Categories load one after another in arrival order, never interleaved.
  let chain: Promise<void> = Promise.resolve();
  try {
    const stats = await buildSiteContextInWorker(
      { centre: options.centre, radius: options.radius, categories: options.categories },
      {
        onProgress: (progress) => { if (!abort.signal.aborted) store().setSiteContextProgress(progress); },
        onCategory: (category) => { chain = chain.then(() => loadCategory(category)); },
      },
      abort.signal,
    );
    await chain;
    if (!abort.signal.aborted) store().finishSiteContextRequest({ ...stats, elapsedMs: performance.now() - started });
  } catch (error) {
    await chain;
    if (isAbort(error) || abort.signal.aborted) {
      store().abortSiteContextRequest();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const stats = error instanceof SiteContextBuildError && error.stats ? { ...error.stats, elapsedMs: performance.now() - started } : null;
    store().setSiteContextError(message);
    store().finishSiteContextRequest(stats, message);
  } finally {
    supersession.signal.removeEventListener('abort', onSuperseded);
    supersession.stop();
  }
}
