/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash config as it rides inside a FLAVOR — split out of `persistence.ts`,
 * whose subject is localStorage. This half never touches storage: it maps
 * between the in-memory preset/settings state and the plain-JSON blob a
 * flavor carries in `settings.clash`, so the two travel with flavor
 * export/import.
 */

import {
  SCHEMA_VERSION,
  builtinPresetIds,
  isValidStoredPreset,
  mergeStoredPresets,
  normalizeSettings,
  presetsToStore,
  type ClashGlobalSettings,
  type ClashPreset,
} from './persistence.js';
import { parseClashSetFilters } from './set-filter.js';

/** Plain-JSON snapshot of clash config stored in a flavor. */
export interface ClashFlavorConfig {
  schemaVersion: number;
  settings: ClashGlobalSettings;
  /** Customs + modified built-ins only (built-ins are re-merged on restore). */
  presets: ClashPreset[];
}

export function serializeClashConfig(presets: ClashPreset[], settings: ClashGlobalSettings): ClashFlavorConfig {
  return { schemaVersion: SCHEMA_VERSION, settings: { ...settings }, presets: presetsToStore(presets) };
}

/**
 * Rebuild clash state from a flavor blob: the full resolved preset list (defaults
 * + the blob's overrides/customs) and bounds-clamped settings. Returns null when
 * the blob is missing/garbage so the caller can skip the restore.
 */
export function deserializeClashConfig(blob: unknown): { presets: ClashPreset[]; settings: ClashGlobalSettings } | null {
  if (!blob || typeof blob !== 'object') return null;
  const b = blob as Partial<ClashFlavorConfig>;
  const storedRaw = Array.isArray(b.presets) ? b.presets : [];
  const stored = storedRaw.filter(isValidStoredPreset).map((p) => ({
    id: p.id,
    name: p.name,
    description: typeof p.description === 'string' ? p.description : '',
    severity: p.severity,
    selectorA: p.selectorA,
    selectorB: p.selectorB,
    enabled: p.enabled !== false,
    builtin: builtinPresetIds().has(p.id),
    ...parseClashSetFilters(p),
  }));
  return { presets: mergeStoredPresets(stored), settings: normalizeSettings(b.settings) };
}
