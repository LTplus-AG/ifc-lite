/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store/types';
import { collectMeshedIds } from '@/lib/object-count';
import { isModelStreaming, sameModelExceptGeometry, streamingRefreshDue } from '@/lib/streaming-refresh';

type Models = Map<string, FederatedModel>;

/** Which ids each geometry result meshes; one scan per result object. */
const meshedIdsByResult = new WeakMap<GeometryResult, Set<number>>();
function meshedIds(result: GeometryResult | null): Set<number> | null {
  if (!result) return null;
  let ids = meshedIdsByResult.get(result);
  if (!ids) meshedIdsByResult.set(result, ids = collectMeshedIds(result));
  return ids;
}

function sameIds(a: Set<number> | null, b: Set<number> | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Every model field except its geometry is identical, the frame the storey
 * badges are read in (`coordinateInfo`, as captured in `frames`) is the same
 * object, and the same ids have geometry.
 *
 * A model still streaming gains geometry on every batch, so it would never
 * compare equal; it is instead held at the previous output until
 * `holdStreaming` says a refresh is due (#6411). Only its geometry (and the
 * frame that rides on it) is held:
 * any other field changing (metadata arriving, a rename, the load finishing)
 * still counts as a change.
 */
function sameForHierarchy(
  prev: Models,
  next: Models,
  frames: ReadonlyMap<string, CoordinateInfo | undefined>,
  holdStreaming: boolean,
): boolean {
  if (prev.size !== next.size) return false;
  const prevEntries = [...prev];
  let i = 0;
  for (const [id, model] of next) {
    const [prevId, prevModel] = prevEntries[i++];
    if (prevId !== id) return false;
    if (prevModel !== model && (isModelStreaming(model) || isModelStreaming(prevModel))) {
      // Every batch carries a fresh `coordinateInfo`, so the frame is held with
      // the rest of the streaming geometry.
      if (holdStreaming && isModelStreaming(model) && isModelStreaming(prevModel) && sameModelExceptGeometry(prevModel, model)) continue;
      // Not worth an id scan per streamed batch: the answer is always "changed".
      return false;
    }
    if (frames.get(id) !== model.geometryResult?.coordinateInfo) return false;
    if (prevModel === model) continue;
    if (!sameModelExceptGeometry(prevModel, model)) return false;
    if (!sameIds(meshedIds(prevModel.geometryResult), meshedIds(model.geometryResult))) return false;
  }
  return true;
}

/**
 * `models` for the hierarchy, held at its previous identity across a geometry
 * update that changes nothing the tree shows (#6232 perf). A re-meshed
 * element swaps meshes but keeps its id, so re-rendering the panel and every
 * visible row for it is wasted work. The tree reads geometry only for WHICH
 * ids have it (and whether a model has geometry at all), and that is exactly
 * what is compared, along with the frame the storey badges read
 * (`coordinateInfo`). A store selector, so an unchanged answer does not even
 * re-render the panel. While a model streams, its growing geometry refreshes
 * the tree at most every `STREAMING_PANEL_REFRESH_MS` (#6411).
 */
export function createHierarchyModelsSelector(): (state: { models: Models; geometryContentVersion: number }) => Models {
  let input: Models | null = null;
  let inputVersion = 0;
  let output: Models | null = null;
  let outputAt = 0;
  let frames = new Map<string, CoordinateInfo | undefined>();
  return (state) => {
    const models = state.models;
    const version = state.geometryContentVersion;
    if (models === input && version === inputVersion) return output!;
    // A content-version bump rewrote geometry IN PLACE (a federation re-align,
    // an RTC rebase), frame included, which no identity check can see.
    const now = performance.now();
    const holdStreaming = !streamingRefreshDue(outputAt, now);
    const reuse = output !== null && version === inputVersion && models.size > 0 && sameForHierarchy(output, models, frames, holdStreaming);
    input = models;
    inputVersion = version;
    if (!reuse) {
      output = models;
      outputAt = now;
      frames = new Map([...models].map(([id, model]) => [id, model.geometryResult?.coordinateInfo]));
    }
    return output!;
  };
}

/** The legacy single-model geometry, which the tree reads only when no model is registered. */
export function selectLegacyHierarchyGeometry(state: { models: Models; geometryResult: GeometryResult | null }): GeometryResult | null {
  return state.models.size > 0 ? null : state.geometryResult;
}
