/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Publish mutation-owned IDs before resolving them through federation. */

interface OverlayPublicationRegistry {
  toGlobalId(modelId: string, expressId: number): number;
  getGlobalIdRange(modelId: string): { start: number; end: number } | null;
  getOffset(modelId: string): number | null;
  publishOverlayRange(modelId: string, start: number, end: number): void;
  previewOverlayGlobalId(modelId: string, start: number, end: number, expressId: number): number;
}

interface OverlayPublicationModel {
  maxExpressId: number;
}

interface OverlayPublicationView {
  getNewEntity(expressId: number): unknown;
}

interface OverlayPublicationState {
  models: ReadonlyMap<string, OverlayPublicationModel>;
  mutationViews: ReadonlyMap<string, OverlayPublicationView>;
}

/** Resolve a mutation-aware federation ID from the relevant store state. */
export function toPublishedGlobalIdFromState(
  registry: OverlayPublicationRegistry,
  state: OverlayPublicationState,
  modelId: string,
  expressId: number,
): number {
  return toPublishedGlobalId(registry, state.models, state.mutationViews, modelId, expressId);
}

/**
 * Resolve a local ID through the strict registry. When the ID belongs to a
 * newly-authored mutation overlay, publish every contiguous overlay record
 * leading to it first. Reserved-but-never-owned IDs remain unresolvable.
 * Publication is intentionally permanent: federation ownership must stay
 * stable when a mutation view subsequently deletes an authored record.
 */
export function toPublishedGlobalId(
  registry: OverlayPublicationRegistry,
  models: ReadonlyMap<string, OverlayPublicationModel>,
  views: ReadonlyMap<string, OverlayPublicationView>,
  modelId: string,
  expressId: number,
): number {
  try {
    return registry.toGlobalId(modelId, expressId);
  } catch (error) {
    const model = models.get(modelId);
    const view = views.get(modelId);
    const offset = registry.getOffset(modelId);
    const published = registry.getGlobalIdRange(modelId);
    if (model === undefined || view === undefined || offset === null || published === null
      || expressId <= model.maxExpressId || view.getNewEntity(expressId) === null) {
      throw error;
    }

    const nextLocalId = published.end - offset + 1;
    if (nextLocalId <= model.maxExpressId || expressId < nextLocalId) throw error;
    for (let localId = nextLocalId; localId <= expressId; localId++) {
      if (view.getNewEntity(localId) === null) throw error;
    }
    registry.publishOverlayRange(modelId, nextLocalId, expressId);
    return registry.toGlobalId(modelId, expressId);
  }
}

/**
 * Convert an exact detached creation batch for temporary GPU staging. The
 * registry remains unpublished until the prepared mutation transaction has
 * committed its records, so a failed GPU preparation cannot burn ownership.
 */
export function previewPreparedOverlayGlobalId(
  registry: OverlayPublicationRegistry,
  models: ReadonlyMap<string, OverlayPublicationModel>,
  modelId: string,
  created: readonly { expressId: number }[],
  expressId: number,
): number {
  const model = models.get(modelId);
  const start = created[0]?.expressId;
  const end = created.at(-1)?.expressId;
  if (model === undefined || !Number.isSafeInteger(expressId) || !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end) || start <= model.maxExpressId || expressId < start || expressId > end) {
    throw new Error('Invalid detached overlay range.');
  }
  for (let index = 0; index < created.length; index++) {
    if (created[index].expressId !== start + index) throw new Error('Detached overlay IDs must be contiguous and source ordered.');
  }
  return registry.previewOverlayGlobalId(modelId, start, end, expressId);
}
