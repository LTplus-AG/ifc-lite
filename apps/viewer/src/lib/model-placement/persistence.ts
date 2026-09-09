/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ModelGeoref } from '@/hooks/ingest/federationAlign';
import type { ViewerState } from '@/store';
import { selectAnchorGeoref } from '@/lib/geo/select-anchor-georef';
import { makePlacementManifest, parsePlacementManifest, resolvePlacementManifest } from './manifest.js';
import type { ModelPlacement } from './state.js';

/** Only coordinate-defining values belong in a frame identity. Descriptions,
 * entity ids and other source metadata do not change the coordinate frame. */
export function georeferencedPlacementFrameKey(georef: ModelGeoref): string {
  const crs = georef.projectedCRS, conversion = georef.mapConversion, info = georef.coordinateInfo;
  return JSON.stringify({ crs: crs && { name: crs.name, mapUnitScale: crs.mapUnitScale },
    conversion: conversion && { eastings: conversion.eastings, northings: conversion.northings,
      orthogonalHeight: conversion.orthogonalHeight, xAxisAbscissa: conversion.xAxisAbscissa,
      xAxisOrdinate: conversion.xAxisOrdinate, scale: conversion.scale },
    lengthUnitScale: georef.lengthUnitScale, originShift: info?.originShift,
    rtc: info?.wasmRtcOffset, rotation: info?.buildingRotation });
}

export function placementFrameKey(state: ViewerState): string {
  if (state.modelPlacement.frameKey) return state.modelPlacement.frameKey;
  // An anchor/georef edit is only a proposal until Re-align actually re-bakes
  // the scene. Start from the loaded source frame; realignment stamps its frame.
  const actualAnchor = [...state.models].find(([, model]) => model.federationAlignmentStatus === 'anchor')?.[0];
  const anchor = selectAnchorGeoref({ models: state.models, georefMutations: new Map(), anchorModelIdOverride: actualAnchor });
  if (!anchor) return 'local-engineering:m:z-up';
  return georeferencedPlacementFrameKey({ ...anchor.eff, coordinateInfo: anchor.coordinateInfo });
}

const PREFIX = 'ifc-lite:placements:v1:';
export function saveWorkspacePlacements(storage: Pick<Storage, 'getItem' | 'setItem'>, state: ViewerState): void {
  const frame = placementFrameKey(state), key = PREFIX + frame;
  const manifest = makePlacementManifest(state.models, state.modelPlacement.placements, frame);
  // Keep unloaded sources for later restoration, but replace all records for
  // loaded fingerprints, including explicit zero/reset placements.
  const previous = storage.getItem(key);
  const incoming = new Set(manifest.models.map((entry) => entry.sourceContentHash));
  if (previous) {
    try {
      const old = parsePlacementManifest(previous);
      manifest.models.push(...old.models.filter((entry) => !incoming.has(entry.sourceContentHash)));
    } catch (error) { console.warn('[Reposition] Replacing invalid saved placements:', error); }
  }
  // Duplicate source instances require explicit manifest bindings on import.
  const counts = new Map<string | null, number>();
  for (const entry of manifest.models) counts.set(entry.sourceContentHash, (counts.get(entry.sourceContentHash) ?? 0) + 1);
  manifest.models = manifest.models.filter((entry) => entry.sourceContentHash !== null && counts.get(entry.sourceContentHash) === 1).slice(0, 1000);
  storage.setItem(key, JSON.stringify(manifest));
}

export function restoreWorkspacePlacements(storage: Pick<Storage, 'getItem'>, state: ViewerState): Map<string, ModelPlacement> {
  const frame = placementFrameKey(state), saved = storage.getItem(PREFIX + frame);
  if (!saved) return new Map();
  const manifest = parsePlacementManifest(saved);
  manifest.models = manifest.models.filter((entry) => entry.sourceContentHash !== null &&
    [...state.models].filter(([, model]) => model.sourceContentHash === entry.sourceContentHash).length === 1);
  const restored = resolvePlacementManifest(manifest, state.models, frame);
  return new Map([...restored].filter(([id]) => !state.modelPlacement.placements.has(id)));
}
