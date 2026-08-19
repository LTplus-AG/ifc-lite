/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sun shadow-map light matrix (issue #2670, Phase 2).
 *
 * Builds the orthographic light-view-projection the sun shadow depth pass
 * renders occluders through. A directional sun is an orthographic camera:
 * the frustum is a box whose axis is the (negated) sun direction, and whose
 * cross-section must cover everything that can cast into the view.
 *
 * Fitting policy: by default the lateral (x/y) extent is fitted to the whole
 * model AABB — a single, well-conditioned cascade that is correct at
 * building scale. A caller MAY instead pass `focusCorners` (e.g. the camera
 * frustum clipped to the model, for a site-scale view-fitted map, maintainer
 * constraint #1 on #2670) and the lateral fit tightens to those; that path is
 * a documented follow-up and needs a proper cascade to be robust against a
 * reverse-Z / infinite-far camera, so the live renderer uses the bounds fit.
 *
 * The DEPTH range is deliberately NOT fitted to the focus alone: an occluder
 * BEHIND the visible region along the sun axis (a roof over the room you are
 * looking at) still has to be in the map to cast into it, so the near plane is
 * pushed back to enclose the whole model along the light direction while the
 * lateral (x/y) extent stays fitted to the focus.
 *
 * Everything here is pure and framework-free so it can be unit-tested without
 * a GPU; the depth pass (`shadow-pass.ts`) consumes {@link SunLightFit}.
 */

import type { Mat4, Vec3 } from './types.js';
import { MathUtils } from './math.js';

export interface SunLightFitParams {
  /**
   * Unit vector TOWARD the sun in viewer/world space (Y-up), matching the
   * shading path's `env.sunDirection` convention. Normalized defensively; a
   * non-finite or zero vector falls back to straight-down sun (Y-up).
   */
  sunDirection: readonly [number, number, number];
  /** World-space model AABB min corner. */
  boundsMin: readonly [number, number, number];
  /** World-space model AABB max corner. */
  boundsMax: readonly [number, number, number];
  /**
   * Eight corners of the camera frustum clipped to the model bounds, world
   * space. When provided the lateral fit uses these (tight, view-fitted map);
   * when omitted or shorter than 4 the model AABB corners are used instead.
   */
  focusCorners?: readonly Vec3[];
  /**
   * Fractional slack added around the fitted lateral extent so a PCF/normal
   * -offset kernel near the map edge still has neighbours to sample. Default
   * 0.05 (5%). Clamped to [0, 1].
   */
  lateralPadding?: number;
}

export interface SunLightFit {
  /** Column-major light view-projection (`ortho * lightView`), reverse-Z. */
  lightViewProj: Mat4;
  /** Light view matrix on its own (world → light view space). */
  lightView: Mat4;
  /** Fitted ortho half-width in world units (light-space x). */
  orthoHalfWidth: number;
  /** Fitted ortho half-height in world units (light-space y). */
  orthoHalfHeight: number;
  /** Near→far depth span along the sun axis, world units. */
  depthRange: number;
}

const DEFAULT_SUN: Vec3 = { x: 0, y: 1, z: 0 };

/** Unit sun direction, falling back to straight down-up for unusable input. */
function resolveSun(dir: readonly [number, number, number]): Vec3 {
  const x = dir[0], y = dir[1], z = dir[2];
  const lenSq = x * x + y * y + z * z;
  // Finiteness matters as much as length (#2489): an Infinity component makes
  // the length Infinity and the divide below NaN, so guard both ends.
  if (!(lenSq > 1e-12 && lenSq < Infinity)) return DEFAULT_SUN;
  const inv = 1 / Math.sqrt(lenSq);
  return { x: x * inv, y: y * inv, z: z * inv };
}

/** The eight corners of an axis-aligned box. */
function aabbCorners(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): Vec3[] {
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    corners.push({
      x: (i & 1) ? max[0] : min[0],
      y: (i & 2) ? max[1] : min[1],
      z: (i & 4) ? max[2] : min[2],
    });
  }
  return corners;
}

/** Transform a world point by a column-major Mat4 (w = 1), returning xyz. */
function transformPoint(m: Float32Array, p: Vec3): Vec3 {
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
  };
}

/**
 * Fit the sun's orthographic shadow frustum. Pure; see the file header for the
 * fitting policy. The returned matrix maps world space straight to the shadow
 * map's clip space (reverse-Z, depth 1 at near → 0 at far), so the depth pass
 * uses it exactly where the main pass uses the camera `viewProj`.
 */
export function fitSunLightMatrix(params: SunLightFitParams): SunLightFit {
  const sun = resolveSun(params.sunDirection);
  const modelCorners = aabbCorners(params.boundsMin, params.boundsMax);

  // Lateral fit target: the view-clipped frustum corners when usable, else the
  // whole model. Depth always encloses the whole model (see header).
  const lateralPts =
    params.focusCorners && params.focusCorners.length >= 4
      ? params.focusCorners
      : modelCorners;

  // Centre the light view on the lateral focus so the fitted x/y box is
  // symmetric around the region of interest.
  let cx = 0, cy = 0, cz = 0;
  for (const p of lateralPts) { cx += p.x; cy += p.y; cz += p.z; }
  const n = lateralPts.length;
  const center: Vec3 = { x: cx / n, y: cy / n, z: cz / n };

  // Light view: eye one unit up-sun of the centre, looking down the sun axis
  // (forward = -sun). The eye offset only shifts light-space z uniformly; near
  // /far below are derived from the transformed points, so its magnitude is
  // immaterial. `up` comes from viewBasis's degeneracy handling for the
  // straight-overhead sun where any fixed up would be parallel.
  const eye: Vec3 = {
    x: center.x + sun.x,
    y: center.y + sun.y,
    z: center.z + sun.z,
  };
  // A world-Y up hint, swapped to world-Z when the sun is near-vertical, keeps
  // the basis well-conditioned; viewBasis substitutes its own hint if this is
  // still parallel, so the result is always finite.
  const upHint: Vec3 = Math.abs(sun.y) > 0.99 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const lightView = MathUtils.lookAt(eye, center, upHint);
  const lv = lightView.m;

  // Lateral (x/y) extent from the focus points.
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const p of lateralPts) {
    const v = transformPoint(lv, p);
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }

  // Depth (z) extent from the WHOLE model, so occluders behind the focus still
  // cast into it. In lookAt view space the camera looks down -Z, so scene
  // points have negative z and their distance from the eye is -z.
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of modelCorners) {
    const vz = lv[2] * p.x + lv[6] * p.y + lv[10] * p.z + lv[14];
    if (vz < minZ) minZ = vz;
    if (vz > maxZ) maxZ = vz;
  }

  // Pad the lateral box so an edge texel's kernel still has neighbours.
  const pad = Math.min(Math.max(params.lateralPadding ?? 0.05, 0), 1);
  const halfW = Math.max((maxX - minX) * 0.5, 1e-4);
  const halfH = Math.max((maxY - minY) * 0.5, 1e-4);
  const midX = (minX + maxX) * 0.5;
  const midY = (minY + maxY) * 0.5;
  const padW = halfW * (1 + pad);
  const padH = halfH * (1 + pad);
  const left = midX - padW;
  const right = midX + padW;
  const bottom = midY - padH;
  const top = midY + padH;

  // Distances along the view direction. In lookAt view space scene points have
  // negative z, so distance = -z: the nearest point (largest z) sets `near`,
  // the farthest (smallest z) sets `far`. `near` is NOT clamped to 0 — the eye
  // sits just up-sun of the FOCUS centre, so model geometry further up-sun is
  // behind it (positive z ⇒ negative near), and clamping would push those
  // occluders out of the depth range so they stopped casting. A small epsilon
  // pads both ends against precision and a zero-thickness (flat) frustum.
  const zEps = Math.max((maxZ - minZ) * 1e-3, 1e-3);
  const near = -maxZ - zEps;
  const far = -minZ + zEps;

  const ortho = MathUtils.orthographicReverseZ(left, right, bottom, top, near, far);
  const lightViewProj = MathUtils.multiply(ortho, lightView);

  return {
    lightViewProj,
    lightView,
    orthoHalfWidth: padW,
    orthoHalfHeight: padH,
    depthRange: far - near,
  };
}

