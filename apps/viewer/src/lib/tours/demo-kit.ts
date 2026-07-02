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

import { EVENT_LOAD_FILE } from './events';

const BASE_NAME = 'building-architecture.ifc';
const REV_B_NAME = 'building-architecture-rev-b.ifc';

export const DEMO_KIT_PATHS = {
  base: `/samples/${BASE_NAME}`,
  revB: `/samples/${REV_B_NAME}`,
  ids: '/samples/building-architecture.ids',
  manifest: '/samples/demo-kit.json',
} as const;

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

/** The exact file names the demo variants load as (compare/IDS gate on
 *  these to distinguish the kit from a user's own model). */
export const DEMO_MODEL_NAMES = { base: BASE_NAME, revB: REV_B_NAME } as const;
