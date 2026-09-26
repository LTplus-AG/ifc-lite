/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TessellationQuality } from '@ifc-lite/geometry';
import type { TranslationKey } from '@/i18n';
import { clearGeomWorkerOverride, peekGeomWorkerOverride } from '@/store/geomWorkerOverride';
import { useViewerStore } from '@/store';

type OverrideValue = string | number | undefined;

interface StickyOverride {
  id: string;
  labelKey: TranslationKey;
  queryParam: string;
  read: (tier: TessellationQuality | undefined) => OverrideValue;
  matchesUrl: (raw: string, value: string) => boolean;
  reset: () => void;
}

/** One row per sticky parameter; Settings is fed only from this registry. */
export const STICKY_OVERRIDES: readonly StickyOverride[] = [
  {
    id: 'geomTier',
    labelKey: 'settings.performance.geometryTier',
    queryParam: 'geomTier',
    read: (tier) => tier,
    matchesUrl: (raw, value) => raw === value,
    reset: () => useViewerStore.getState().clearGeomTierOverride(),
  },
  {
    id: 'geomWorkers',
    labelKey: 'settings.performance.geometryWorkers',
    queryParam: 'geomWorkers',
    read: () => peekGeomWorkerOverride(),
    matchesUrl: (raw, value) => String(Number.parseInt(raw, 10)) === value,
    reset: clearGeomWorkerOverride,
  },
];

export interface ActiveStickyOverride {
  definition: StickyOverride;
  value: string;
  source: 'url' | 'saved';
}

export function activeStickyOverrides(tier: TessellationQuality | undefined): ActiveStickyOverride[] {
  const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const active: ActiveStickyOverride[] = [];
  for (const definition of STICKY_OVERRIDES) {
    const value = definition.read(tier);
    if (value === undefined) continue;
    const rendered = String(value);
    const raw = params.get(definition.queryParam);
    active.push({
      definition,
      value: rendered,
      source: raw !== null && definition.matchesUrl(raw, rendered) ? 'url' : 'saved',
    });
  }
  return active;
}
