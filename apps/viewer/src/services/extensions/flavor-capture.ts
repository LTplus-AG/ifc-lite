/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Flavor } from '@ifc-lite/extensions';
import { encodeSavedLens } from '@/lib/lens/migrate-saved-lens';
import { serializeClashConfig } from '@/lib/clash/persistence.flavor';
import { useViewerStore } from '@/store';
/** The native Capture/New snapshot controls share the same live saved lens, clash and sidebar capture. */
export function captureNativeFlavor(target: Flavor): Flavor {
  const state = useViewerStore.getState();
  return { ...target,
    lenses: state.savedLenses.map(lens => ({ id: lens.id, name: lens.name ?? lens.id, definition: encodeSavedLens(lens) as unknown as Flavor['lenses'][number]['definition'] })),
    settings: { ...target.settings, clash: captureClashConfig() } as Flavor['settings'],
    layout: { ...target.layout, state: { ...target.layout.state, sidebar: state.serializeSidebarLayout() as unknown as Flavor['layout']['state'][string] } },
    updatedAt: new Date().toISOString(),
  };
}
export function createNativeFlavor(name: string, description: string, snapshot: boolean): Flavor {
  if (!name.trim()) throw new Error('A nonempty native flavor name is required.');
  const now = new Date().toISOString(), stamp = now.replace(/[:.]/g, '-').toLowerCase(), slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const flavor: Flavor = { schemaVersion: 1, id: `local.${slug || 'flavor'}.${stamp}`, name, description, createdAt: now, updatedAt: now, extensions: [], lenses: [], savedQueries: [], keybindings: [], layout: { state: {} }, settings: {} };
  return snapshot ? captureNativeFlavor(flavor) : flavor;
}

/** Snapshot the current clash rule-set + detection settings for a flavor's
 *  `settings.clash` blob, so each profile carries its own clash config. */
export function captureClashConfig(): unknown {
  const s = useViewerStore.getState();
  return serializeClashConfig(s.clashPresets, {
    mode: s.clashMode,
    tolerance: s.clashTolerance,
    clearance: s.clashClearance,
    duplicateTolerance: s.clashDuplicateTolerance,
    clusterEpsilon: s.clashClusterEpsilon,
    reportTouch: s.clashReportTouch,
    groupBy: s.clashGroupBy,
  });
}
