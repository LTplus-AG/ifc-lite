/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { finiteTranslation, assertRenderableTranslation, type Translation } from './translation.js';
import type { ModelPlacement } from './state.js';

export interface PlacementManifestEntry {
  instanceId: string;
  sourceContentHash: string | null;
  translation: Translation;
  locked: boolean;
}
export interface PlacementManifest {
  version: 1;
  units: 'm';
  axes: 'engineering-z-up';
  frameKey: string;
  models: PlacementManifestEntry[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function shortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

/** Validate the entire document before applying any member of an imported group. */
export function parsePlacementManifest(text: string): PlacementManifest {
  if (text.length > 2_000_000) throw new Error('Placement manifest exceeds 2 MB.');
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.version !== 1 || value.units !== 'm' || value.axes !== 'engineering-z-up' ||
    !shortString(value.frameKey) || !Array.isArray(value.models) || value.models.length > 1000) {
    throw new Error('Unsupported placement manifest. Expected version 1, metres, and engineering Z-up axes.');
  }
  const seen = new Set<string>();
  const models: PlacementManifestEntry[] = value.models.map((entry: unknown) => {
    if (!record(entry) || !shortString(entry.instanceId) ||
      !(entry.sourceContentHash === null || shortString(entry.sourceContentHash)) ||
      !finiteTranslation(entry.translation) || typeof entry.locked !== 'boolean' || seen.has(entry.instanceId)) {
      throw new Error('Invalid or duplicate model placement entry.');
    }
    assertRenderableTranslation(entry.translation);
    seen.add(entry.instanceId);
    return { instanceId: entry.instanceId, sourceContentHash: entry.sourceContentHash,
      translation: [...entry.translation], locked: entry.locked };
  });
  return { version: 1, units: 'm', axes: 'engineering-z-up', frameKey: value.frameKey, models };
}

export function makePlacementManifest(
  models: ReadonlyMap<string, { sourceContentHash?: string }>, placements: ReadonlyMap<string, ModelPlacement>, frameKey: string,
): PlacementManifest {
  return { version: 1, units: 'm', axes: 'engineering-z-up', frameKey,
    models: [...models].map(([instanceId, model]) => ({ instanceId, sourceContentHash: model.sourceContentHash ?? null,
      translation: placements.get(instanceId)?.translation ?? [0, 0, 0], locked: placements.get(instanceId)?.locked ?? false })) };
}

/** Unambiguous fingerprint matching only. Duplicate sources need explicit instance
 * bindings, never a filename match or an ordinal that can shift after removal. */
export function resolvePlacementManifest(
  manifest: PlacementManifest, loaded: ReadonlyMap<string, { sourceContentHash?: string }>, frameKey: string,
  bindings: ReadonlyMap<string, string> = new Map(),
): Map<string, ModelPlacement> {
  if (manifest.frameKey !== frameKey) throw new Error('The placement coordinate frame differs from this workspace.');
  const result = new Map<string, ModelPlacement>();
  for (const entry of manifest.models) {
    const explicit = bindings.get(entry.instanceId);
    const candidates = explicit ? [[explicit, loaded.get(explicit)] as const].filter(([, model]) => model !== undefined)
      : [...loaded].filter(([id, model]) => entry.sourceContentHash
        ? model.sourceContentHash === entry.sourceContentHash : id === entry.instanceId);
    const savedCopies = manifest.models.filter((item) => item.sourceContentHash === entry.sourceContentHash).length;
    if (candidates.length !== 1 || (!explicit && entry.sourceContentHash !== null && savedCopies > 1)) {
      throw new Error('A source is missing or ambiguous. Bind each saved model instance to a loaded model.');
    }
    const [id, model] = candidates[0];
    if (entry.sourceContentHash !== null && model?.sourceContentHash !== entry.sourceContentHash) {
      throw new Error('A bound model has different source contents.');
    }
    if (result.has(id)) throw new Error('Two saved placements cannot target the same model instance.');
    result.set(id, { translation: [...entry.translation], locked: entry.locked });
  }
  return result;
}
