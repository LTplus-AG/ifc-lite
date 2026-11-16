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
import type { SiteContextArrival } from '@/hooks/modelLoadOptions';
import { watchLoadSupersession } from '@/hooks/modelLoadCanceller';
import { buildSiteContextInWorker, SiteContextBuildError } from './site-context-client';
import type { SiteContextCategoryMessage } from './site-context-job';
import { siteContextFileName } from './site-context-glb';
import { siteContextModelName } from './site-context-model';

export type SiteContextAddModel = (file: File, options: { name: string; siteContextArrival: SiteContextArrival }) => Promise<string | null>;

export interface LoadSiteContextOptions {
  anchorModelId: string;
  centre: { x: number; y: number };
  radius: SiteContextRadius;
  categories: SiteContextLayerKind[];
  imagery: boolean;
  /** The model's own building, for the buildings layer to mark (and the viewer to hide). */
  subject?: { egid?: string; footprint?: Array<Array<{ x: number; y: number }>> };
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
  // A run detached by the slice (its anchor model removed, all models cleared) is aborted
  // here, by the run itself: a teardown only drops the handle, since it may not act (#10481 review).
  let settled = false;
  const unsubscribe = useViewerStore.subscribe((state) => {
    if (!settled && state.siteContextAbort !== abort && !abort.signal.aborted) abort.abort();
  });
  const started = performance.now();
  const drape = options.drapeImagery
    ?? (async (modelId: string, signal: AbortSignal) => (await import('./site-context-imagery')).drapeSiteContextImagery(modelId, signal));

  // This run's identity is its controller: it writes only while it is the current run, so a
  // cancelled, replaced or detached run never touches a newer run's state (#10481 review).
  const current = (): boolean => !abort.signal.aborted && store().isSiteContextRunCurrent(abort);

  const loadCategory = async (category: SiteContextCategoryMessage): Promise<void> => {
    if (!current()) return;
    const { kind } = category;
    store().setSiteContextCategory(abort, kind, { issues: category.issues, attribution: category.attribution });
    if (!category.hasGeometry) {
      store().setSiteContextCategory(abort, kind, { status: 'error' });
      return;
    }
    // The shared load step (`adoptSiteContextModel`, on every path) replaces the earlier
    // model of this kind once the new one is in, and points the category at it; this run
    // only says which run the arrival belongs to (#10481 review).
    const file = new File([category.bytes.slice().buffer], siteContextFileName(kind));
    const siteContextArrival = { run: abort, anchorModelId: options.anchorModelId, isCurrent: current };
    let modelId: string | null;
    try {
      modelId = await options.addModel(file, { name: siteContextModelName(kind), siteContextArrival });
    } catch (error) {
      // A load that throws fails this category only: the chain goes on to the next category and the
      // run still settles (an unhandled rejection here left the request running forever; #10481 review).
      console.error(`[site-context] loading the ${kind} failed:`, error);
      if (!current()) return;
      const kept = store().siteContextCategories[kind];
      store().setSiteContextCategory(abort, kind, {
        status: 'error',
        issues: [...(kept?.issues ?? []), { code: 'site-context-load-failed', severity: 'error', message: `the ${kind} could not be loaded: ${error instanceof Error ? error.message : String(error)}` }],
      });
      return;
    }
    if (!current()) {
      // The run ended while its model was being added: it was not adopted, so take it out again.
      if (modelId) options.removeModel(modelId);
      return;
    }
    if (!modelId) {
      // The new model did not load: the previous one of this kind (if any) stays, and the category says why.
      const kept = store().siteContextCategories[kind];
      const previous = [...store().siteContextModels].some(([, record]) => record.kind === kind);
      store().setSiteContextCategory(abort, kind, {
        status: 'error',
        issues: [...(kept?.issues ?? []), { code: 'site-context-load-failed', severity: 'error', message: `the new ${kind} could not be loaded${previous ? '; the previous one is still shown' : ''}` }],
      });
      return;
    }
    // Whether the layer was complete is this run's to say (the shared step has no run status).
    store().setSiteContextCategory(abort, kind, { status: categoryStatusOf(true, category.complete), modelId, anchorModelId: options.anchorModelId });
    if (kind !== 'terrain' || !options.imagery) return;
    try {
      await drape(modelId, abort.signal);
    } catch (error) {
      if (isAbort(error) || !current()) return;
      console.error('[site-context] imagery drape failed:', error);
      const terrain = store().siteContextCategories.terrain;
      store().setSiteContextCategory(abort, 'terrain', {
        status: 'partial',
        issues: [...(terrain?.issues ?? []), {
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
      { centre: options.centre, radius: options.radius, categories: options.categories, ...(options.subject ? { subject: options.subject } : {}) },
      {
        onProgress: (progress) => { if (current()) store().setSiteContextProgress(abort, progress); },
        onCategory: (category) => { chain = chain.then(() => loadCategory(category)); },
      },
      abort.signal,
    );
    await chain;
    settled = true;
    if (abort.signal.aborted) store().settleAbortedSiteContextRun(abort);
    else store().finishSiteContextRequest(abort, { ...stats, elapsedMs: performance.now() - started });
  } catch (error) {
    await chain;
    settled = true;
    if (isAbort(error) || abort.signal.aborted) {
      // Settles only this run, and only if it is still the current one: never the run after it.
      store().settleAbortedSiteContextRun(abort);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const stats = error instanceof SiteContextBuildError && error.stats ? { ...error.stats, elapsedMs: performance.now() - started } : null;
    store().setSiteContextError(abort, message);
    store().finishSiteContextRequest(abort, stats, message);
  } finally {
    unsubscribe();
    supersession.signal.removeEventListener('abort', onSuperseded);
    supersession.stop();
  }
}
