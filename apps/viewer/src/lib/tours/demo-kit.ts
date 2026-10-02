/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Demo-kit loaders. The kit demos the tours on the committed sample
 * `building-architecture.ifc` plus two small variants derived from its
 * bytes by `tools/demo-kit/derive-variants.mts` (a GlobalId-preserving
 * revision B for compare, which also carries an injected hard clash, and a
 * targeted IDS spec); tours must never regenerate them at runtime. Loading
 * rides the existing `ifc-lite:load-file` bus event whose listener routes
 * into the normal loadFile pipeline (so `store.source` bytes are retained
 * for IDS et al).
 */

import { getViewerStoreApi } from '@/store';
import type { ViewerState } from '@/store';
import { loadIdsContent } from '@/hooks/ids/loadIdsContent';
import { EVENT_ADD_MODEL, EVENT_LOAD_FILE } from './events';

const BASE_NAME = 'building-architecture.ifc';
const REV_B_NAME = 'building-architecture-rev-b.ifc';

export const DEMO_KIT_PATHS = {
  base: `/samples/${BASE_NAME}`,
  revB: `/samples/${REV_B_NAME}`,
  ids: '/samples/building-architecture.ids',
  manifest: '/samples/demo-kit.json',
} as const;

/**
 * Resolve when at least one model is fully loaded and nothing is streaming.
 * The load pipeline registers a placeholder model record before parsing, so
 * `models.size > 0` alone is NOT "loaded".
 */
export function waitForModelSettled(timeoutMs = 180_000): Promise<void> {
  const store = getViewerStoreApi();
  const settled = (s: ViewerState) => s.models.size > 0 && !s.loading && !s.geometryStreamingActive;
  return new Promise((resolve, reject) => {
    if (settled(store.getState())) { resolve(); return; }
    const timer = window.setTimeout(() => {
      unsub();
      reject(new Error('model load did not settle in time'));
    }, timeoutMs);
    const unsub = store.subscribe((s) => {
      if (settled(s)) {
        window.clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

async function fetchAsFile(path: string, name: string): Promise<File> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`demo kit fetch failed: ${res.status} ${path}`);
  const blob = await res.blob();
  return new File([blob], name, { type: 'application/x-step' });
}

/**
 * The demo project as a `File`, for callers that already hold the canonical
 * `loadFile` (the first-run card) and so need no bus event.
 */
export function fetchDemoProjectFile(): Promise<File> {
  return fetchAsFile(DEMO_KIT_PATHS.base, BASE_NAME);
}

let demoProjectInFlight: Promise<void> | null = null;

/**
 * Load the demo project into the viewer, replacing the current model (the
 * `ifc-lite:load-file` listener routes to `loadFile`). The caller observes
 * completion through the store (`models.size > 0 && !loading &&
 * !geometryStreamingActive`) - same contract as a user-driven open.
 */
export function loadDemoProject(): Promise<void> {
  // One fetch at a time: a tour step's "Load demo project" and a later
  // step's `ensureTourModel` can overlap while the store still reads empty,
  // and a second dispatch would REPLACE the first demo mid-tour.
  demoProjectInFlight ??= fetchDemoProjectFile()
    .then((file) => {
      // detail IS the File - useFileCommands reads e.detail directly.
      window.dispatchEvent(new CustomEvent(EVENT_LOAD_FILE, { detail: file }));
    })
    .finally(() => { demoProjectInFlight = null; });
  return demoProjectInFlight;
}

/**
 * A tour step that cannot mean anything without a model (read its data,
 * browse its tree) calls this from `prepare`: a model already loaded, or
 * loading, is waited for; an empty viewer gets the demo project. The welcome
 * tour's own load step is skippable, and skipping it with nothing loaded used
 * to leave every later step anchored to an empty panel, so they broke
 * (`tour_step_broken` prerequisite-not-met on welcome/inspect and
 * welcome/structure). Loading into an EMPTY set replaces nothing, so it never
 * trips the tour's model-change abort.
 */
export async function ensureTourModel(): Promise<void> {
  const s = getViewerStoreApi().getState();
  if (isViewerEmpty(s)) await loadDemoProject();
  // A legacy single-model store is loaded without a `models` entry, which
  // `waitForModelSettled` would wait on forever.
  else if (s.models.size === 0 && !s.loading) return;
  await waitForModelSettled();
}

/**
 * Nothing loaded and nothing loading: the one definition of an empty viewer
 * that the tour's demo fallback, its "Skip (use demo)" label and the
 * panels' no-model state share (#6720). A legacy single-model store
 * (`ifcDataStore` without a `models` entry) counts as loaded, so the demo
 * never replaces it.
 */
export function isViewerEmpty(s: Pick<ViewerState, 'models' | 'ifcDataStore' | 'loading'>): boolean {
  return s.models.size === 0 && !s.ifcDataStore && !s.loading;
}

/**
 * Add demo revision B to the CURRENT federation set (the compare tour needs
 * base + rev B loaded side by side). Rides the add-model bus event, so it
 * goes through the canonical `addModel` path with ID-offset registration.
 */
export async function loadDemoRevB(): Promise<void> {
  const file = await fetchAsFile(DEMO_KIT_PATHS.revB, REV_B_NAME);
  window.dispatchEvent(new CustomEvent(EVENT_ADD_MODEL, { detail: file }));
}

/**
 * Both demo revisions for the compare tour, replacing whatever is loaded
 * (diffing an arbitrary user model against the demo would be garbage - the
 * prerequisite interstitial says so before this runs). The caller observes
 * settle through the store, same as `loadDemoProject`.
 */
export async function loadDemoRevisions(): Promise<void> {
  await loadDemoProject();
  // The base load REPLACES the model set asynchronously; adding rev B before
  // it settles races the replace's clear and can be silently wiped.
  await waitForModelSettled();
  await loadDemoRevB();
}

/**
 * Load ONLY the revision-B variant (replacing the current model) for the
 * clash tour: the base building-architecture sample has no interpenetrations,
 * but rev B carries an injected duct that clashes with an existing wall.
 */
export async function loadDemoClashModel(): Promise<void> {
  const file = await fetchAsFile(DEMO_KIT_PATHS.revB, REV_B_NAME);
  window.dispatchEvent(new CustomEvent(EVENT_LOAD_FILE, { detail: file }));
}

/**
 * The demo IDS together with the model it is authored against: validating an
 * arbitrary user model against the demo spec would be noise, so the demo
 * project is swapped in first unless a kit model is already loaded. Shared by
 * the IDS tour's "Load demo spec" action and the IDS panel's "Try with demo
 * data" empty state (#5834).
 */
export async function loadDemoIdsWithProject(): Promise<void> {
  const models = [...getViewerStoreApi().getState().models.values()];
  if (!models.some((m) => isDemoKitModelName(m.name))) {
    await loadDemoProject();
    await waitForModelSettled();
  }
  await loadDemoIds();
}

/** Load the bundled IDS spec (parse + audit) without the panel mounted. */
export async function loadDemoIds(): Promise<void> {
  const res = await fetch(DEMO_KIT_PATHS.ids);
  if (!res.ok) throw new Error(`demo kit fetch failed: ${res.status} ${DEMO_KIT_PATHS.ids}`);
  loadIdsContent(getViewerStoreApi(), await res.text());
}

/** The exact file names the demo variants load as (compare/IDS gate on
 *  these to distinguish the kit from a user's own model). */
export const DEMO_MODEL_NAMES = { base: BASE_NAME, revB: REV_B_NAME } as const;

/** Exact kit names only, so a user's own similarly-named file is never
 *  mistaken for the demo. */
export function isDemoKitModelName(name: string): boolean {
  return name === BASE_NAME || name === REV_B_NAME;
}

/**
 * Whether an analysis panel may offer "Try with demo data" (#5834). Loading
 * the kit REPLACES the model set, which is only harmless when nothing is
 * loaded or everything loaded already is the kit; a user's own model is never
 * swapped out from an empty state.
 */
export function demoKitReplacesNothing(models: Iterable<{ name: string }>): boolean {
  for (const model of models) if (!isDemoKitModelName(model.name)) return false;
  return true;
}
