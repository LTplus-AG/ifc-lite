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
  const { start, end } = preparedOverlayRange(models, modelId, created);
  if (!Number.isSafeInteger(expressId) || expressId < start || expressId > end) {
    throw new Error('Invalid detached overlay range.');
  }
  return registry.previewOverlayGlobalId(modelId, start, end, expressId);
}

/**
 * Resolve an ID used by a detached native plan without granting it federation
 * ownership. Live rows are published through the normal state path; only an
 * ID in this plan's exact, contiguous creation batch may use the temporary
 * preview mapping. This keeps holes and unrelated reservations unresolvable.
 */
export function toPreparedOverlayGlobalId(
  registry: OverlayPublicationRegistry,
  state: OverlayPublicationState,
  modelId: string,
  created: readonly { expressId: number }[],
  expressId: number,
): number {
  try {
    return toPublishedGlobalId(registry, state.models, state.mutationViews, modelId, expressId);
  } catch (error) {
    if (!created.length) throw error;
    const { start, end } = preparedOverlayRange(state.models, modelId, created);
    if (expressId < start || expressId > end) throw error;
    // Earlier committed overlays must become owned before a later detached
    // batch can be previewed. A missing committed row remains a hard error.
    toPublishedGlobalId(registry, state.models, state.mutationViews, modelId, start - 1);
    return registry.previewOverlayGlobalId(modelId, start, end, expressId);
  }
}

/** Publish an exact detached batch only after every committed row is live. */
export function publishPreparedOverlayRange(
  registry: OverlayPublicationRegistry,
  models: ReadonlyMap<string, OverlayPublicationModel>,
  views: ReadonlyMap<string, OverlayPublicationView>,
  modelId: string,
  created: readonly { expressId: number }[],
): void {
  const { start, end } = preparedOverlayRange(models, modelId, created);
  const view = views.get(modelId);
  if (view === undefined) throw new Error('The committed overlay view is unavailable.');
  for (let localId = start; localId <= end; localId++) {
    if (view.getNewEntity(localId) === null) throw new Error('Committed overlay IDs must remain contiguous and owned.');
  }
  registry.publishOverlayRange(modelId, start, end);
}

/**
 * Verify a just-committed overlay while every later publication step is still
 * reversible. The returned action is side-effect free until the caller's GPU
 * commit has succeeded. Unregistered models intentionally keep the canonical
 * one-model `globalId === expressId` fallback.
 */
export function preparePreparedOverlayPublication(
  registry: OverlayPublicationRegistry,
  state: OverlayPublicationState,
  modelId: string,
  created: readonly { expressId: number }[],
): (() => void) | null {
  if (!created.length) return null;
  // Only genuinely unregistered primary models use the canonical local-ID
  // fallback. A reserved model with no published base range is an invalid
  // federation lifecycle state and must fail before GPU ownership changes.
  if (registry.getOffset(modelId) === null) return null;
  if (registry.getGlobalIdRange(modelId) === null) {
    throw new Error('Committed overlay IDs require a published federation base range.');
  }
  const { start, end } = preparedOverlayRange(state.models, modelId, created);
  const view = state.mutationViews.get(modelId);
  const offset = registry.getOffset(modelId);
  if (view === undefined || offset === null || created.some(row => view.getNewEntity(row.expressId) === null)) {
    throw new Error('Committed overlay IDs must remain contiguous and owned.');
  }
  // This can only publish an older, already-live prefix. The new range stays
  // unowned until its GPU ownership transaction has completed.
  toPublishedGlobalId(registry, state.models, state.mutationViews, modelId, start - 1);
  const range = registry.getGlobalIdRange(modelId);
  if (range === null || range.end - offset + 1 !== start) {
    throw new Error('Committed overlay IDs must extend federation ownership contiguously.');
  }
  // Validate the exact headroom reservation now. `publishOverlayRange` would
  // reject it too, but only after GPU tokens have been consumed.
  registry.previewOverlayGlobalId(modelId, start, end, start);
  return () => registry.publishOverlayRange(modelId, start, end);
}

function preparedOverlayRange(
  models: ReadonlyMap<string, OverlayPublicationModel>,
  modelId: string,
  created: readonly { expressId: number }[],
): { start: number; end: number } {
  const model = models.get(modelId);
  const first = created[0], last = created.at(-1);
  if (model === undefined || first === undefined || last === undefined
    || !Number.isSafeInteger(first.expressId) || !Number.isSafeInteger(last.expressId)
    || first.expressId <= model.maxExpressId) {
    throw new Error('Invalid detached overlay range.');
  }
  const start = first.expressId, end = last.expressId;
  for (let index = 0; index < created.length; index++) {
    if (created[index].expressId !== start + index) throw new Error('Detached overlay IDs must be contiguous and source ordered.');
  }
  return { start, end };
}
