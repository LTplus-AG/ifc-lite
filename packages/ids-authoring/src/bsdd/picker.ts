/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bSDD tab of the entity, classification and property pickers
 * (05-bsdd.md §2.1, IDS-069) as a framework-free view model: filters
 * pre-filled from the specification, a debounced search with stale-result
 * protection, and the result cards. A UI renders `getState()` and calls
 * `setQuery` / `setFilters`; it never talks to bSDD itself.
 */

import type { GateContext } from '../gate/context.js';
import { literals } from '../gate/grounding.js';
import type { StudioDocument } from '../document/types.js';
import { locateSpec } from '../document/node-index.js';
import type { Uuid } from '../uuid.js';
import {
  BsddUnavailableError,
  type BsddClass,
  type BsddClassSummary,
  type BsddDictionary,
  type BsddSource,
  type BsddStatus,
} from './types.js';

export interface BsddPickerFilters {
  /** Dictionaries to search (empty: all). Defaults come from the document's configured list. */
  dictionaryUris: string[];
  languageCode?: string;
  /** Related IFC entity, PascalCase (`IfcWall`). Pre-filled from the applicability. */
  relatedIfcEntity?: string;
  /** Hide classes bSDD marks inactive. Default true. */
  activeOnly: boolean;
}

export interface BsddPropertyPreview {
  code: string;
  name: string;
  propertySet?: string;
  dataType?: string;
  required: boolean;
}

export interface BsddClassCard {
  uri: string;
  code: string;
  name: string;
  definition?: string;
  dictionary: { uri: string; name?: string; version?: string };
  relatedIfcEntities: string[];
  status?: BsddStatus;
  /** Known once the class details are loaded. */
  propertyCount?: number;
  properties?: BsddPropertyPreview[];
}

/**
 * Initial filters for a picker opened on `specId`: the related IFC entity
 * is the single literal applicability entity, in EXPRESS PascalCase.
 */
export function initialPickerFilters(
  doc: StudioDocument,
  specId: Uuid | undefined,
  options: { dictionaryUris?: readonly string[]; languageCode?: string; gate?: GateContext } = {},
): BsddPickerFilters {
  const filters: BsddPickerFilters = { dictionaryUris: [...(options.dictionaryUris ?? [])], activeOnly: true };
  if (options.languageCode) filters.languageCode = options.languageCode;
  const index = specId === undefined ? undefined : locateSpec(doc, specId);
  if (index === undefined) return filters;
  const spec = doc.ids.specifications[index];
  const names = spec.applicability.facets.flatMap((f) => (f.type === 'entity' ? literals(f.name) : []));
  if (names.length !== 1) return filters;
  const upper = names[0].toUpperCase();
  const pascal = spec.ifcVersions.map((v) => options.gate?.tables[v].entities.get(upper)?.name).find((n) => !!n);
  filters.relatedIfcEntity = pascal ?? names[0];
  return filters;
}

function dictionaryInfo(uri: string, dictionaries?: ReadonlyMap<string, BsddDictionary>, fallbackName?: string): BsddClassCard['dictionary'] {
  const d = dictionaries?.get(uri);
  const name = d?.name ?? fallbackName;
  return { uri, ...(name ? { name } : {}), ...(d?.version ? { version: d.version } : {}) };
}

export function cardFromSummary(s: BsddClassSummary, dictionaries?: ReadonlyMap<string, BsddDictionary>): BsddClassCard {
  const card: BsddClassCard = {
    uri: s.uri,
    code: s.code,
    name: s.name,
    dictionary: dictionaryInfo(s.dictionaryUri, dictionaries, s.dictionaryName),
    relatedIfcEntities: [...s.relatedIfcEntityNames],
  };
  if (s.definition) card.definition = s.definition;
  if (s.status) card.status = s.status;
  return card;
}

export function cardFromClass(c: BsddClass, dictionaries?: ReadonlyMap<string, BsddDictionary>, previewLimit = 8): BsddClassCard {
  const card: BsddClassCard = {
    uri: c.uri,
    code: c.code,
    name: c.name,
    dictionary: dictionaryInfo(c.dictionaryUri, dictionaries),
    relatedIfcEntities: [...c.relatedIfcEntityNames],
    status: c.status,
    propertyCount: c.properties.length,
    properties: c.properties.slice(0, previewLimit).map((p) => ({
      code: p.code,
      name: p.name,
      ...(p.propertySet ? { propertySet: p.propertySet } : {}),
      ...(p.dataType ? { dataType: p.dataType } : {}),
      required: p.isRequired === true,
    })),
  };
  if (c.definition) card.definition = c.definition;
  return card;
}

export type BsddSearchPhase = 'idle' | 'debouncing' | 'loading' | 'ready' | 'error';

export interface BsddSearchState {
  query: string;
  filters: BsddPickerFilters;
  phase: BsddSearchPhase;
  cards: BsddClassCard[];
  total: number;
  /** True when the last failure was "bSDD unreachable and not cached". */
  offline: boolean;
  error?: string;
}

export interface BsddSearchTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface BsddSearchOptions {
  source: BsddSource;
  filters: BsddPickerFilters;
  dictionaries?: ReadonlyMap<string, BsddDictionary>;
  /** Default 250 ms (05-bsdd.md §4). */
  debounceMs?: number;
  /** Queries shorter than this do not search. Default 2. */
  minChars?: number;
  timers?: BsddSearchTimers;
  onChange?: (state: BsddSearchState) => void;
}

export interface BsddSearch {
  getState(): BsddSearchState;
  setQuery(query: string): void;
  setFilters(patch: Partial<BsddPickerFilters>): void;
  /** Run a pending debounced search now; resolves when it has settled. */
  flush(): Promise<void>;
  dispose(): void;
}

const DEFAULT_TIMERS: BsddSearchTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** The debounced search behind the bSDD picker tab. */
export function createBsddSearch(options: BsddSearchOptions): BsddSearch {
  const timers = options.timers ?? DEFAULT_TIMERS;
  const debounceMs = options.debounceMs ?? 250;
  const minChars = options.minChars ?? 2;
  let state: BsddSearchState = { query: '', filters: options.filters, phase: 'idle', cards: [], total: 0, offline: false };
  let pending: unknown;
  let seq = 0;
  let inflight: Promise<void> = Promise.resolve();
  let disposed = false;

  const set = (patch: Partial<BsddSearchState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    options.onChange?.(state);
  };

  async function run(): Promise<void> {
    pending = undefined;
    const mine = ++seq;
    const { query, filters } = state;
    set({ phase: 'loading' });
    try {
      const page = await options.source.searchClasses({
        text: query.trim(),
        ...(filters.dictionaryUris.length ? { dictionaryUris: filters.dictionaryUris } : {}),
        ...(filters.relatedIfcEntity ? { relatedIfcEntity: filters.relatedIfcEntity } : {}),
        ...(filters.languageCode ? { languageCode: filters.languageCode } : {}),
      });
      if (mine !== seq) return; // a newer search superseded this one
      const rows = filters.activeOnly ? page.classes.filter((c) => c.status !== 'inactive') : page.classes;
      set({ phase: 'ready', cards: rows.map((c) => cardFromSummary(c, options.dictionaries)), total: page.total, offline: false, error: undefined });
    } catch (err) {
      if (mine !== seq) return;
      const offline = err instanceof BsddUnavailableError;
      set({ phase: 'error', cards: [], total: 0, offline, error: offline ? 'bSDD is offline and this search is not cached' : String(err instanceof Error ? err.message : err) });
    }
  }

  function schedule(): void {
    if (pending !== undefined) timers.clear(pending);
    pending = undefined;
    if (state.query.trim().length < minChars) {
      seq++;
      set({ phase: 'idle', cards: [], total: 0, error: undefined });
      return;
    }
    set({ phase: 'debouncing' });
    pending = timers.set(() => {
      inflight = run();
    }, debounceMs);
  }

  return {
    getState: () => state,
    setQuery(query) {
      if (query === state.query) return;
      set({ query });
      schedule();
    },
    setFilters(patch) {
      set({ filters: { ...state.filters, ...patch } });
      schedule();
    },
    async flush() {
      if (pending !== undefined) {
        timers.clear(pending);
        inflight = run();
      }
      await inflight;
    },
    dispose() {
      if (pending !== undefined) timers.clear(pending);
      disposed = true;
    },
  };
}
