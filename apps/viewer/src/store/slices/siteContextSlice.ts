/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Site context state: the request the user made ("Load site context"), how
 * each category of it is doing, and what every loaded site-context model
 * carries that the viewport and the metadata panel must show (attribution,
 * issues, the height assumption).
 *
 * Two lifetimes live here on purpose. A REQUEST belongs to the fetch the user
 * started: it has an abort handle and per-category progress, and a new
 * request replaces it. A MODEL record belongs to a loaded site-context model,
 * however it arrived (fetched here, or a GLB written by the CLI and dropped on
 * the viewer), and lives until that model is removed. The attribution line
 * reads the model records, never the request, so a dropped file is attributed
 * exactly like a fetched one.
 *
 * The fetch itself (worker, cache, loading each category through `loadFile`)
 * is `lib/site-context/site-context-fetch.ts`; this slice only records it.
 */

import type { StateCreator } from 'zustand';
import type { Attribution } from '@ifc-lite/geodata-ch';
import type { SiteContextIssue, SiteContextLayerKind, SiteContextProgress } from '@ifc-lite/site-context';
import { defineSliceTeardown } from '../teardown.js';

export type SiteContextRadius = 100 | 200 | 300 | 500;
export const SITE_CONTEXT_RADII: readonly SiteContextRadius[] = [100, 200, 300, 500];
/** The categories the viewer can request. `buildings` arrives from the core when it is built; nothing here changes then. */
export const SITE_CONTEXT_CATEGORIES: readonly SiteContextLayerKind[] = ['terrain', 'parcel', 'buildings'];

/**
 * `idle` nothing asked or cancelled; `fetching` in flight; `done` complete;
 * `partial` loaded but the core says incomplete (see `issues`); `error`
 * nothing could be loaded for it.
 */
export type SiteContextCategoryStatus = 'idle' | 'fetching' | 'partial' | 'done' | 'error';

export interface SiteContextCategoryState {
  status: SiteContextCategoryStatus;
  /** The model this category loaded as, once it has. */
  modelId?: string;
  /** The model the loaded category was fetched around: one site context per scene, shown in every section. */
  anchorModelId?: string;
  issues: SiteContextIssue[];
  attribution: Attribution[];
}

export interface SiteContextRequest {
  /** The georeferenced model the context was fetched around. */
  anchorModelId: string;
  /** EPSG:2056, easting first. */
  centre: { x: number; y: number };
  radius: SiteContextRadius;
  categories: SiteContextLayerKind[];
  imagery: boolean;
  startedAt: number;
}

/** What the live run cost, for the panel and the record. */
export interface SiteContextRunStats {
  requests: number;
  bytes: number;
  cacheHits: number;
  elapsedMs: number;
}

/** What a loaded site-context model must show wherever it is shown. */
export interface SiteContextModelInfo {
  kind: SiteContextLayerKind;
  attribution: Attribution[];
  issues: SiteContextIssue[];
  complete: boolean;
  /** Frame origin [E, N, H], EPSG:2056 / EPSG:5728. */
  origin: [number, number, number];
  /** Terrain only: the plan box `[minE, minN, maxE, maxN]` (EPSG:2056) the meshes' UVs span, for the aerial drape. */
  planBox?: [number, number, number, number];
  /**
   * Buildings only: the model's own building as found among the neighbours,
   * hidden at load so the model stands in its place (model-local express ids).
   */
  hiddenSubject?: { expressIds: number[]; name: string; method: string; overlap?: number };
  /** The anchor states no vertical datum, so its heights were taken as LN02 (owner's rule). */
  heightAssumed?: boolean;
  /** Set once aerial imagery is draped on this (terrain) model. */
  imagery?: { attribution: Attribution; groundSampleDistance: number; /** The sharper drape on the chunks around the model. */ nearGroundSampleDistance?: number };
  /** Set while the overland flow hazard map (BAFU) is draped on this (terrain) model, over the imagery or alone. */
  hazard?: { attribution: Attribution; groundSampleDistance: number; nearGroundSampleDistance?: number };
}

/** What the user last asked for, kept after the run ends so the section can offer it again. */
export interface SiteContextChoice {
  radius: SiteContextRadius;
  categories: SiteContextLayerKind[];
  imagery: boolean;
}

/**
 * Run state belongs to one run. `siteContextAbort` is the run's identity: a
 * run writes only while it is still the current one (its controller is the
 * one in the slice), so a cancelled, replaced or detached run cannot touch a
 * newer run's state. `siteContextRequest` is the running request only, and
 * is cleared however the run ends (success, error, cancel, its anchor model
 * removed, all models cleared).
 */
export interface SiteContextSlice {
  /** The running request; `null` when no run is in progress. */
  siteContextRequest: SiteContextRequest | null;
  siteContextLastChoice: SiteContextChoice | null;
  siteContextCategories: Partial<Record<SiteContextLayerKind, SiteContextCategoryState>>;
  siteContextProgress: SiteContextProgress | null;
  siteContextAbort: AbortController | null;
  siteContextStats: SiteContextRunStats | null;
  /** Request-level failures (coverage, network) that belong to no category. */
  siteContextError: string | null;
  siteContextModels: Map<string, SiteContextModelInfo>;

  /** Start a request: every requested category is `fetching`, others are left out. Replaces (and aborts) a running one. */
  beginSiteContextRequest: (request: SiteContextRequest, abort: AbortController) => void;
  /** True while `run` is the current run: every write below from a run is ignored otherwise. */
  isSiteContextRunCurrent: (run: AbortController) => boolean;
  setSiteContextProgress: (run: AbortController, progress: SiteContextProgress | null) => void;
  setSiteContextCategory: (run: AbortController, kind: SiteContextLayerKind, patch: Partial<SiteContextCategoryState>) => void;
  /** The run ended (normally or not): categories still `fetching` become `error` with `reason`. */
  finishSiteContextRequest: (run: AbortController, stats: SiteContextRunStats | null, reason?: string) => void;
  /** User cancel of the current run: aborts the fetch; categories still `fetching` return to `idle`, finished ones stay. */
  abortSiteContextRequest: () => void;
  /** A run that saw its own abort settles, if it is still the current one; never touches a newer run. */
  settleAbortedSiteContextRun: (run: AbortController) => void;
  setSiteContextError: (run: AbortController, message: string | null) => void;
  /** A site-context model arrived outside any fetch run (a dropped site-context GLB): its category points at it. */
  recordArrivedSiteContextCategory: (kind: SiteContextLayerKind, patch: Partial<SiteContextCategoryState>) => void;
  registerSiteContextModel: (modelId: string, info: SiteContextModelInfo) => void;
  updateSiteContextModel: (modelId: string, patch: Partial<SiteContextModelInfo>) => void;
}

/** Map a finished category to its status: loaded and complete, loaded but incomplete, or nothing. */
export function categoryStatusOf(loaded: boolean, complete: boolean): SiteContextCategoryStatus {
  if (!loaded) return 'error';
  return complete ? 'done' : 'partial';
}

function settleFetching(
  categories: SiteContextSlice['siteContextCategories'],
  status: SiteContextCategoryStatus,
  issue?: SiteContextIssue,
): SiteContextSlice['siteContextCategories'] {
  const next: SiteContextSlice['siteContextCategories'] = {};
  for (const [kind, state] of Object.entries(categories) as Array<[SiteContextLayerKind, SiteContextCategoryState]>) {
    next[kind] = state.status === 'fetching'
      ? { ...state, status, issues: issue ? [...state.issues, issue] : state.issues }
      : state;
  }
  return next;
}

/** A run that ends without finishing: what was in flight returns to idle, finished categories stay. */
function cancelledRun(state: Pick<SiteContextSlice, 'siteContextCategories'>): Partial<SiteContextSlice> {
  return {
    siteContextCategories: settleFetching(state.siteContextCategories, 'idle'),
    siteContextRequest: null,
    siteContextProgress: null,
    siteContextAbort: null,
  };
}

export const createSiteContextSlice: StateCreator<SiteContextSlice, [], [], SiteContextSlice> = (set, get) => ({
  siteContextRequest: null,
  siteContextLastChoice: null,
  siteContextCategories: {},
  siteContextProgress: null,
  siteContextAbort: null,
  siteContextStats: null,
  siteContextError: null,
  siteContextModels: new Map(),

  beginSiteContextRequest: (request, abort) => {
    get().siteContextAbort?.abort();
    // A request changes only the kinds it asks for: the others keep their records (and their
    // models stay in the scene, #10481 review). A kind fetched again still points at its loaded
    // model until a new one arrives and replaces it.
    const categories: SiteContextSlice['siteContextCategories'] = settleFetching(get().siteContextCategories, 'idle');
    for (const kind of request.categories) {
      const loaded = get().siteContextCategories[kind];
      categories[kind] = { status: 'fetching', issues: [], attribution: [], ...(loaded?.modelId ? { modelId: loaded.modelId, anchorModelId: loaded.anchorModelId } : {}) };
    }
    set({
      siteContextRequest: request,
      siteContextLastChoice: { radius: request.radius, categories: request.categories, imagery: request.imagery },
      siteContextCategories: categories,
      siteContextProgress: null,
      siteContextAbort: abort,
      siteContextStats: null,
      siteContextError: null,
    });
  },

  isSiteContextRunCurrent: (run) => get().siteContextAbort === run,

  setSiteContextProgress: (run, progress) => set((state) => (state.siteContextAbort === run ? { siteContextProgress: progress } : {})),

  setSiteContextCategory: (run, kind, patch) => set((state) => {
    if (state.siteContextAbort !== run) return {};
    const current = state.siteContextCategories[kind] ?? { status: 'idle', issues: [], attribution: [] };
    return { siteContextCategories: { ...state.siteContextCategories, [kind]: { ...current, ...patch } } };
  }),

  finishSiteContextRequest: (run, stats, reason) => set((state) => (state.siteContextAbort !== run ? {} : {
    siteContextCategories: settleFetching(
      state.siteContextCategories, 'error',
      reason ? { code: 'site-context-failed', severity: 'error', message: reason } : undefined,
    ),
    siteContextRequest: null,
    siteContextProgress: null,
    siteContextAbort: null,
    siteContextStats: stats,
  })),

  abortSiteContextRequest: () => {
    get().siteContextAbort?.abort();
    set(cancelledRun);
  },

  settleAbortedSiteContextRun: (run) => set((state) => (state.siteContextAbort === run ? cancelledRun(state) : {})),

  setSiteContextError: (run, message) => set((state) => (state.siteContextAbort === run ? { siteContextError: message } : {})),

  recordArrivedSiteContextCategory: (kind, patch) => set((state) => {
    const current = state.siteContextCategories[kind] ?? { status: 'idle', issues: [], attribution: [] };
    return { siteContextCategories: { ...state.siteContextCategories, [kind]: { ...current, ...patch } } };
  }),

  registerSiteContextModel: (modelId, info) => set((state) => {
    const models = new Map(state.siteContextModels);
    models.set(modelId, info);
    return { siteContextModels: models };
  }),

  updateSiteContextModel: (modelId, patch) => set((state) => {
    const current = state.siteContextModels.get(modelId);
    if (!current) return {};
    const models = new Map(state.siteContextModels);
    models.set(modelId, { ...current, ...patch });
    return { siteContextModels: models };
  }),
});

/**
 * Session reset drops the request and every model record (the models are gone
 * too). The abort handle is dropped, not called: a teardown is pure. The fetch
 * stops on its own, because it watches primary-load supersession.
 */
export const siteContextTeardown = defineSliceTeardown(
  'siteContextSlice',
  [
    'siteContextRequest', 'siteContextLastChoice', 'siteContextCategories', 'siteContextProgress', 'siteContextAbort',
    'siteContextStats', 'siteContextError', 'siteContextModels',
  ],
  {
    'session-reset': () => ({
      siteContextRequest: null,
      siteContextLastChoice: null,
      siteContextCategories: {},
      siteContextProgress: null,
      siteContextAbort: null,
      siteContextStats: null,
      siteContextError: null,
      siteContextModels: new Map(),
    }),
    'model-removed': (scope, state) => {
      const categories = state.siteContextCategories ?? {};
      const stale = Object.entries(categories).filter(([, c]) => c?.modelId === scope.modelId);
      // Removing the model a run fetches around ends that run: the handle is dropped (a teardown
      // may not act), the run sees it is no longer current and aborts itself (site-context-fetch).
      const endsRun = state.siteContextRequest?.anchorModelId === scope.modelId;
      if (!state.siteContextModels?.has(scope.modelId) && stale.length === 0 && !endsRun) return {};
      const models = new Map(state.siteContextModels);
      models.delete(scope.modelId);
      // A category that loaded as the removed model is no longer loaded: back to idle (#10481 review).
      let next = { ...categories };
      for (const [kind] of stale) next[kind as SiteContextLayerKind] = { status: 'idle', issues: [], attribution: [] };
      if (endsRun) next = settleFetching(next, 'idle');
      return {
        siteContextModels: models,
        siteContextCategories: next,
        ...(endsRun ? { siteContextRequest: null, siteContextProgress: null, siteContextAbort: null } : {}),
      };
    },
    'all-models-cleared': () => ({
      siteContextModels: new Map(), siteContextCategories: {}, siteContextRequest: null, siteContextProgress: null, siteContextAbort: null,
    }),
  },
);

/** Model records whose model is still loaded and visible: what the attribution line shows. */
export function visibleSiteContextModels(
  records: ReadonlyMap<string, SiteContextModelInfo>,
  models: ReadonlyMap<string, { visible?: boolean }>,
): Array<[string, SiteContextModelInfo]> {
  return [...records].filter(([id]) => models.get(id)?.visible !== false && models.has(id));
}
