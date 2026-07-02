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
 * Load the demo project into the viewer, replacing the current model (the
 * `ifc-lite:load-file` listener routes to `loadFile`). The caller observes
 * completion through the store (`models.size > 0 && !loading &&
 * !geometryStreamingActive`) - same contract as a user-driven open.
 */
export async function loadDemoProject(): Promise<void> {
  const file = await fetchAsFile(DEMO_KIT_PATHS.base, BASE_NAME);
  // detail IS the File - the MainToolbar listener reads e.detail directly.
  window.dispatchEvent(new CustomEvent(EVENT_LOAD_FILE, { detail: file }));
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

/** Load the bundled IDS spec (parse + audit) without the panel mounted. */
export async function loadDemoIds(): Promise<void> {
  const res = await fetch(DEMO_KIT_PATHS.ids);
  if (!res.ok) throw new Error(`demo kit fetch failed: ${res.status} ${DEMO_KIT_PATHS.ids}`);
  loadIdsContent(getViewerStoreApi(), await res.text());
}

/** The exact file names the demo variants load as (compare/IDS gate on
 *  these to distinguish the kit from a user's own model). */
export const DEMO_MODEL_NAMES = { base: BASE_NAME, revB: REV_B_NAME } as const;
