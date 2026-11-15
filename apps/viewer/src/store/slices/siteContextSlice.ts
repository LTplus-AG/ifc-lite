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
  /** The anchor states no vertical datum, so its heights were taken as LN02 (owner's rule). */
  heightAssumed?: boolean;
  /** Set once aerial imagery is draped on this (terrain) model. */
  imagery?: { attribution: Attribution; groundSampleDistance: number; /** The sharper drape on the chunks around the model. */ nearGroundSampleDistance?: number };
}

export interface SiteContextSlice {
  siteContextRequest: SiteContextRequest | null;
  siteContextCategories: Partial<Record<SiteContextLayerKind, SiteContextCategoryState>>;
  siteContextProgress: SiteContextProgress | null;
  siteContextAbort: AbortController | null;
  siteContextStats: SiteContextRunStats | null;
  /** Request-level failures (coverage, network) that belong to no category. */
  siteContextError: string | null;
  siteContextModels: Map<string, SiteContextModelInfo>;

  /** Start a request: every requested category is `fetching`, others are left out. Replaces (and aborts) a running one. */
  beginSiteContextRequest: (request: SiteContextRequest, abort: AbortController) => void;
  setSiteContextProgress: (progress: SiteContextProgress | null) => void;
  setSiteContextCategory: (kind: SiteContextLayerKind, patch: Partial<SiteContextCategoryState>) => void;
  /** The run ended (normally or not): categories still `fetching` become `error` with `reason`. */
  finishSiteContextRequest: (stats: SiteContextRunStats | null, reason?: string) => void;
  /** User cancel: aborts the fetch; categories still `fetching` return to `idle`, finished ones stay. */
  abortSiteContextRequest: () => void;
  setSiteContextError: (message: string | null) => void;
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

export const createSiteContextSlice: StateCreator<SiteContextSlice, [], [], SiteContextSlice> = (set, get) => ({
  siteContextRequest: null,
  siteContextCategories: {},
  siteContextProgress: null,
  siteContextAbort: null,
  siteContextStats: null,
  siteContextError: null,
  siteContextModels: new Map(),

  beginSiteContextRequest: (request, abort) => {
    get().siteContextAbort?.abort();
    const categories: SiteContextSlice['siteContextCategories'] = {};
    for (const kind of request.categories) categories[kind] = { status: 'fetching', issues: [], attribution: [] };
    set({
      siteContextRequest: request,
      siteContextCategories: categories,
      siteContextProgress: null,
      siteContextAbort: abort,
      siteContextStats: null,
      siteContextError: null,
    });
  },

  setSiteContextProgress: (progress) => set({ siteContextProgress: progress }),

  setSiteContextCategory: (kind, patch) => set((state) => {
    const current = state.siteContextCategories[kind] ?? { status: 'idle', issues: [], attribution: [] };
    return { siteContextCategories: { ...state.siteContextCategories, [kind]: { ...current, ...patch } } };
  }),

  finishSiteContextRequest: (stats, reason) => set((state) => ({
    siteContextCategories: settleFetching(
      state.siteContextCategories, 'error',
      reason ? { code: 'site-context-failed', severity: 'error', message: reason } : undefined,
    ),
    siteContextProgress: null,
    siteContextAbort: null,
    siteContextStats: stats,
  })),

  abortSiteContextRequest: () => {
    get().siteContextAbort?.abort();
    set((state) => ({
      siteContextCategories: settleFetching(state.siteContextCategories, 'idle'),
      siteContextProgress: null,
      siteContextAbort: null,
    }));
  },

  setSiteContextError: (message) => set({ siteContextError: message }),

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
    'siteContextRequest', 'siteContextCategories', 'siteContextProgress', 'siteContextAbort',
    'siteContextStats', 'siteContextError', 'siteContextModels',
  ],
  {
    'session-reset': () => ({
      siteContextRequest: null,
      siteContextCategories: {},
      siteContextProgress: null,
      siteContextAbort: null,
      siteContextStats: null,
      siteContextError: null,
      siteContextModels: new Map(),
    }),
    'model-removed': (scope, state) => {
      if (!state.siteContextModels?.has(scope.modelId)) return {};
      const models = new Map(state.siteContextModels);
      models.delete(scope.modelId);
      return { siteContextModels: models };
    },
    'all-models-cleared': () => ({ siteContextModels: new Map() }),
  },
);

/** Model records whose model is still loaded and visible: what the attribution line shows. */
export function visibleSiteContextModels(
  records: ReadonlyMap<string, SiteContextModelInfo>,
  models: ReadonlyMap<string, { visible?: boolean }>,
): Array<[string, SiteContextModelInfo]> {
  return [...records].filter(([id]) => models.get(id)?.visible !== false && models.has(id));
}
