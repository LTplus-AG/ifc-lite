/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { federationFrameInfo } from '@ifc-lite/geometry/world-frame';
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
 * already-loaded model's `CoordinateInfo`; CRS, conversion, `lengthUnitScale`,
 * `originShift` and `buildingRotation` are untouched by it. Keeping it out of
 * this pure function means the live RTC anchor never gets baked into a value
 * that might be pinned (`placementFrameBaseKey`) and later go stale; the
 * live anchor is instead appended uniformly by `placementFrameKey`, outside
 * anything that could ever be a decision made once rather than read fresh. */
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
 * uncommitted georeference edit. Shared by placement identity and references.
 *
 * Falls back to `federationFrameInfo` (`@ifc-lite/geometry/world-frame`),
 * NOT an ad-hoc "earliest model with a `geometryResult`" scan: that rule
 * reports a near-origin model's raw frame whenever it loaded first, which is
 * wrong for a raw point cloud in particular (`rtc-rebase.ts`: point clouds
 * never join the RTC frame, so their own `coordinateInfo` never carries a
 * `wasmRtcOffset` even once the rest of the federation has converged).
 * `federationFrameInfo` is the anchor rule #4897 actually settles on:
 * earliest-loaded model WITH a `wasmRtcOffset`, else earliest with any frame
 * (#4936 review). */
export function placementFrameCoordinateInfo(state: ViewerState) {
  const anchor = placementAnchor(state);
  return anchor?.coordinateInfo ?? federationFrameInfo(state.models.values(), state.geometryResult);
}

/**
 * The workspace's frame identity, ALWAYS reconstructed from the live
 * `state.models` (via `placementAnchor`), except for one case: once
 * `commitRealignmentFrame` (`realignment-frame.ts`) has recorded an explicit
 * re-alignment in `modelPlacement.realignedFrameKey`, that decision wins.
 * `placementAnchor`/`selectAnchorGeoref` deliberately reads only each
 * model's OWN embedded georeference, never a committed re-alignment (see its
 * comment), so a live recompute cannot rediscover "the user re-aligned this
 * workspace to CRS X" on its own; `realignedFrameKey` is the one piece of
 * this identity that is genuinely decided STATE rather than a derived value.
 *
 * Everything else here is deliberately NOT cached (#4936, rounds 1-3): three
 * different call sites each tried stamping a computed result into
 * `modelPlacement` at their own moment (a commit, a restore), and each time
 * some later anchor change (an RTC convergence, a model removed from the
 * federation) went unreflected because nothing invalidated the stamp. This
 * is not a hot path (`state.models` federations are small; this runs from
 * user actions and effects, never a render loop), so there is nothing to
 * memoize: every call walks `state.models` fresh. */
export function placementFrameBaseKey(state: ViewerState): string {
  if (state.modelPlacement.realignedFrameKey) return state.modelPlacement.realignedFrameKey;
  const anchor = placementAnchor(state);
  return anchor ? georeferencedPlacementFrameKey({ ...anchor.eff, coordinateInfo: anchor.coordinateInfo }) : 'local-engineering:m:z-up';
}

/** `wasmRtcOffset` normalized so `-0` and `0` serialize identically; real
 * IFC-space RTC anchors are never exactly zero on one axis only, but a
 * collision here would silently merge two distinct frames (#4936 review). */
function normalizeRtc(rtc: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const norm = (n: number) => (n === 0 ? 0 : n);
  return { x: norm(rtc.x), y: norm(rtc.y), z: norm(rtc.z) };
}

/**
 * The full frame identity a saved placement is keyed against: the
 * {@link placementFrameBaseKey} (pinned decision or live anchor CRS/conversion)
 * plus whatever RTC anchor the federation is CURRENTLY converged onto,
 * appended uniformly as a suffix and read live on every call, whether the
 * base came from a pin or from `placementAnchor`.
 *
 * A rotation pivot is a workspace POINT, only meaningful in the render frame
 * it was captured in, unlike a translation, which is a difference and so is
 * frame-invariant (see the file header). `convergeFederationRtcFrame`
 * (#4906/#4897) shifts every converged model's render-frame origin, and any
 * live placement pivot with it (`rebasePlacementPivots`), by the same delta.
 * Nothing here is ever cached, so a convergence is reflected on the very
 * next read regardless of what was committed, restored or removed before
 * it: two independently-converged sessions that reach the SAME live anchor
 * compare equal, and two that reach different ones do not, even one that
 * pinned an explicit re-alignment first.
 *
 * `lib/appearance/reference-runtime/frame.ts`'s `engineeringFrame` strips
 * this same `:rtc:` suffix back off before comparing: an appearance
 * reference stores absolute IFC-world coordinates, so an RTC change alone is
 * deliberately not a frame mismatch for it, only a genuine base change is.
 */
export function placementFrameKey(state: ViewerState): string {
  const rtc = placementFrameCoordinateInfo(state)?.wasmRtcOffset;
  return rtc ? `${placementFrameBaseKey(state)}:rtc:${JSON.stringify(normalizeRtc(rtc))}` : placementFrameBaseKey(state);
}

/** v1.47.0 shipped `georeferencedPlacementFrameKey` embedding the live RTC
 * anchor directly in the base JSON's `rtc` field, before this fix (#4936)
 * moved it to the external `:rtc:{...}` suffix `placementFrameKey` appends
 * now (see that function's own header comment). Reproduces that exact shape
 * so `restoreWorkspacePlacements` can still find placements a real user
 * already saved under it, released and in production localStorage before
 * this round shipped.
 *
 * Only safe for the GEOREFERENCED case: its base already uniquely
 * identifies a CRS/conversion, so moving `rtc` from an embedded field to an
 * external suffix is a lossless rename, nothing new collides. There is
 * deliberately no equivalent for the LOCAL-ENGINEERING case: its pre-fix key
 * was the bare constant `'local-engineering:m:z-up'` with no `rtc` at all,
 * which is EXACTLY the collision #4936 reports (every anchor collapsed onto
 * one key). Falling back to that constant here would hand a placement saved
 * under one anchor to a different, incompatible one, i.e. resurrect the
 * reported bug in the name of migrating away from it. Placements saved
 * under that collapsed key stay unreachable; that data was already
 * unreliable before this fix (#4936 round 5 review). */
function legacyGeoreferencedFrameKey(state: ViewerState): string | undefined {
  const anchor = placementAnchor(state);
  if (!anchor) return undefined;
  const crs = anchor.eff.projectedCRS, conversion = anchor.eff.mapConversion, info = anchor.coordinateInfo;
  return JSON.stringify({ crs: crs && { name: crs.name, mapUnitScale: crs.mapUnitScale },
    conversion: conversion && { eastings: conversion.eastings, northings: conversion.northings,
      orthogonalHeight: conversion.orthogonalHeight, xAxisAbscissa: conversion.xAxisAbscissa,
      xAxisOrdinate: conversion.xAxisOrdinate, scale: conversion.scale,
      factorX: conversion.factorX, factorY: conversion.factorY, factorZ: conversion.factorZ },
    lengthUnitScale: anchor.eff.lengthUnitScale, originShift: info?.originShift,
    rtc: info?.wasmRtcOffset, rotation: info?.buildingRotation });
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
  const frame = placementFrameKey(state);
  let saved = storage.getItem(PREFIX + frame), resolveFrame = frame;
  // Nothing under the current key: try the pre-#4936 georeferenced key
  // format once, so a real placement saved under v1.47.0 is not silently
  // dropped (see `legacyGeoreferencedFrameKey`). `resolveFrame` is the
  // legacy string itself, matching `manifest.frameKey` as saved, not the
  // current `frame`; the next save writes back under the current key.
  if (!saved) {
    const legacy = legacyGeoreferencedFrameKey(state);
    if (legacy && legacy !== frame) { saved = storage.getItem(PREFIX + legacy); resolveFrame = legacy; }
  }
  if (!saved) return new Map();
  const manifest = parsePlacementManifest(saved);
  manifest.models = manifest.models.filter((entry) => entry.sourceContentHash !== null &&
    [...state.models].filter(([, model]) => model.sourceContentHash === entry.sourceContentHash).length === 1);
  const restored = resolvePlacementManifest(manifest, state.models, resolveFrame);
  return new Map([...restored].filter(([id]) => !state.modelPlacement.placements.has(id)));
}
