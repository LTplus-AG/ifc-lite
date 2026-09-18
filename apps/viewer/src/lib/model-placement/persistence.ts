/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ModelGeoref } from '@/hooks/ingest/federationAlign';
import type { ViewerState } from '@/store';
import { selectAnchorGeoref } from '@/lib/geo/select-anchor-georef';
import { makePlacementManifest, parsePlacementManifest, resolvePlacementManifest } from './manifest.js';
import type { ModelPlacement } from './state.js';

/** Only coordinate-defining values belong in a frame identity. Descriptions,
 * entity ids and other source metadata do not change the coordinate frame.
 *
 * Deliberately excludes `wasmRtcOffset`: a federation RTC convergence
 * (`convergeFederationRtcFrame`, #4897/#4906) rewrites ONLY that field on an
 * already-loaded model's `CoordinateInfo`. CRS, conversion, `lengthUnitScale`,
 * `originShift` and `buildingRotation` are untouched by it. This key is the
 * part of the frame identity that is safe to pin (`modelPlacement.frameKey`,
 * see `placementFrameBaseKey`) across a commit or a realignment without going
 * stale; the live RTC anchor is folded in separately by {@link placementFrameKey}
 * itself, on every read, so it can never be served from a stale cache (#4936). */
export function georeferencedPlacementFrameKey(georef: ModelGeoref): string {
  const crs = georef.projectedCRS, conversion = georef.mapConversion, info = georef.coordinateInfo;
  return JSON.stringify({ crs: crs && { name: crs.name, mapUnitScale: crs.mapUnitScale },
    conversion: conversion && { eastings: conversion.eastings, northings: conversion.northings,
      orthogonalHeight: conversion.orthogonalHeight, xAxisAbscissa: conversion.xAxisAbscissa,
      xAxisOrdinate: conversion.xAxisOrdinate, scale: conversion.scale,
      factorX: conversion.factorX, factorY: conversion.factorY, factorZ: conversion.factorZ },
    lengthUnitScale: georef.lengthUnitScale, originShift: info?.originShift, rotation: info?.buildingRotation });
}

function placementAnchor(state: ViewerState) {
  // An anchor/georef edit is only a proposal until Re-align actually re-bakes
  // the scene. Start from the loaded source frame; realignment stamps its frame.
  const actualAnchor = [...state.models].find(([, model]) => model.federationAlignmentStatus === 'anchor')?.[0];
  return selectAnchorGeoref({ models: state.models, georefMutations: new Map(), anchorModelIdOverride: actualAnchor });
}

/** The committed workspace anchor, never the currently selected model or an
 * uncommitted georeference edit. Shared by placement identity and references. */
export function placementFrameCoordinateInfo(state: ViewerState) {
  const anchor = placementAnchor(state);
  return anchor?.coordinateInfo ?? [...state.models.values()].sort((a, b) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0))
    .find(model => model.geometryResult)?.geometryResult?.coordinateInfo ?? state.geometryResult?.coordinateInfo;
}

/** The frame identity WITHOUT the live RTC anchor: `modelPlacement.frameKey`
 * once a commit (`applyModelTranslation`, `setModelRotation`) or a
 * realignment (`commitRealignmentFrame`) has stamped one, else computed fresh
 * from the current georeferenced anchor, else the fixed local-engineering
 * string. Safe to cache, since nothing in it moves under an RTC convergence.
 *
 * This is what a commit stamps into `modelPlacement.frameKey`, NOT
 * {@link placementFrameKey}'s full return value: caching the full value would
 * freeze the very RTC suffix this split exists to keep live, resurrecting
 * #4936 for every commit made before a later convergence. */
export function placementFrameBaseKey(state: ViewerState): string {
  if (state.modelPlacement.frameKey) return state.modelPlacement.frameKey;
  const anchor = placementAnchor(state);
  return anchor ? georeferencedPlacementFrameKey({ ...anchor.eff, coordinateInfo: anchor.coordinateInfo }) : 'local-engineering:m:z-up';
}

/** `wasmRtcOffset` normalized so `-0` and `0` serialize identically; real
 * IFC-space RTC anchors are never exactly zero on one axis only, but a
 * collision here would silently merge two distinct frames (#4936 review). */
function rtcSuffix(rtc: { x: number; y: number; z: number } | null | undefined): string {
  if (!rtc) return '';
  const norm = (n: number) => (n === 0 ? 0 : n);
  return `:rtc:${JSON.stringify({ x: norm(rtc.x), y: norm(rtc.y), z: norm(rtc.z) })}`;
}

/**
 * The full frame identity a saved placement is keyed against: the pinnable
 * {@link placementFrameBaseKey} plus whatever RTC anchor the federation is
 * CURRENTLY converged onto, read live on every call and never cached.
 *
 * A rotation pivot is a workspace POINT, only meaningful in the render frame
 * it was captured in, unlike a translation, which is a difference and so is
 * frame-invariant (see the file header). `convergeFederationRtcFrame`
 * (#4906/#4897) shifts every converged model's render-frame origin, and any
 * live placement pivot with it (`rebasePlacementPivots`), by the same delta,
 * but it never touches `modelPlacement.frameKey`, nor should it: the BASE
 * identity did not change, and clearing the pin would also throw away the
 * stability `commitRealignmentFrame` relies on across a renamed/reloaded
 * anchor model. So the RTC anchor is folded in here, outside the cache,
 * instead. A convergence is then reflected on the very next read, whether or
 * not anything was committed (hence cached) before it. Reading it fresh every
 * time also means two independently-converged sessions that reach the SAME
 * live anchor compare equal, and two that reach different ones do not, even
 * when both committed a placement before their respective convergence.
 */
export function placementFrameKey(state: ViewerState): string {
  return placementFrameBaseKey(state) + rtcSuffix(placementFrameCoordinateInfo(state)?.wasmRtcOffset);
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
