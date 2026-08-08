/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Colour and visibility operations on the playground scene's entity registry.
 *
 * These are the bodies behind `viewer_colorize`, `viewer_isolate`,
 * `viewer_hide` / `viewer_show`, `viewer_reset`, `viewer_color_by_storey` and
 * `viewer_color_by_property`. All of them only read the registry and mutate
 * materials, which is why they sit outside the scene factory: none of them
 * needs the renderer, the camera, or the animation loop.
 */

import * as THREE from 'three';
import type { ColorTuple } from './playground-viewer-types';
import { isTranslucent, selectTargets, type EntityRecord, type EntityRegistry } from './playground-scene-registry';
import type { SectionState } from './playground-scene-view';

export function colorize(
  reg: EntityRegistry,
  args: { globalIds?: string[]; expressIds?: number[]; type?: string; color: ColorTuple },
): { count: number } {
  const targets = selectTargets(reg, args);
  const c = new THREE.Color(args.color[0], args.color[1], args.color[2]);
  // Always set transparency state, even when the new alpha is opaque —
  // otherwise a previous translucent colorize leaves the entity
  // permanently see-through until reset(). Treat alpha as part of the
  // base colour so subsequent reset() / clear-selection paths put it
  // back, not pick a stale opacity from before this call.
  const alpha = args.color[3] ?? 1;
  // `depthWrite` is derived from transparency at construction, so it has to be
  // re-derived here too: leaving it stale makes a translucent repaint write
  // depth and occlude what is behind it (#2444).
  const translucent = isTranslucent(alpha);
  for (const r of targets) {
    const mat = r.mesh.material as THREE.MeshStandardMaterial;
    mat.color.copy(c);
    r.baseColor.copy(c);
    mat.transparent = translucent;
    mat.depthWrite = !translucent;
    mat.opacity = alpha;
    r.baseOpacity = alpha;
  }
  return { count: targets.length };
}

export function isolate(
  reg: EntityRegistry,
  args: { globalIds?: string[]; expressIds?: number[]; type?: string },
): { count: number } {
  const targets = new Set(selectTargets(reg, args));
  for (const r of reg.records) {
    r.mesh.visible = targets.has(r);
  }
  return { count: targets.size };
}

export function hide(
  reg: EntityRegistry,
  args: { globalIds?: string[]; expressIds?: number[]; type?: string },
): { count: number } {
  const targets = selectTargets(reg, args);
  for (const r of targets) r.mesh.visible = false;
  return { count: targets.length };
}

export function show(
  reg: EntityRegistry,
  args: { globalIds?: string[]; expressIds?: number[]; type?: string },
): { count: number } {
  const targets = selectTargets(reg, args);
  for (const r of targets) r.mesh.visible = true;
  return { count: targets.length };
}

export function reset(reg: EntityRegistry, section: SectionState): void {
  for (const r of reg.records) {
    r.mesh.visible = true;
    const mat = r.mesh.material as THREE.MeshStandardMaterial;
    mat.color.copy(r.baseColor);
    mat.opacity = r.baseOpacity;
    // Same derived pair as construction and colorize() (#2444).
    const translucent = isTranslucent(r.baseOpacity);
    mat.transparent = translucent;
    mat.depthWrite = !translucent;
  }
  section.active = null;
  section.planes.length = 0;
}

export function colorByStorey(reg: EntityRegistry): { groups: number } {
  const { byStorey } = reg;
  // Distinct hue per storey. HSV evenly spaced.
  const storeyNames = Array.from(byStorey.keys());
  storeyNames.forEach((name, i) => {
    const h = (i / Math.max(1, storeyNames.length)) * 0.85;
    const c = new THREE.Color().setHSL(h, 0.6, 0.55);
    for (const r of byStorey.get(name) ?? []) {
      (r.mesh.material as THREE.MeshStandardMaterial).color.copy(c);
      r.baseColor.copy(c);
    }
  });
  return { groups: storeyNames.length };
}

export function colorByProperty(
  reg: EntityRegistry,
  { type, sample }: {
    type: string;
    pset: string;
    property: string;
    sample: (expressId: number) => string | number | boolean | null;
  },
): { legend: Array<{ value: string; count: number; color: ColorTuple }> } {
  const records = reg.byType.get(type) ?? [];
  const buckets = new Map<string, EntityRecord[]>();
  for (const r of records) {
    const v = sample(r.expressId);
    const key = v == null ? '(missing)' : String(v);
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  const PALETTE: ColorTuple[] = [
    [0.84, 1.0, 0.25, 1],
    [0.48, 0.45, 0.95, 1],
    [1.0, 0.36, 0.86, 1],
    [0.45, 0.85, 0.79, 1],
    [1.0, 0.62, 0.39, 1],
    [0.62, 0.81, 0.42, 1],
    [0.50, 0.50, 0.55, 1],
  ];
  const legend: Array<{ value: string; count: number; color: ColorTuple }> = [];
  let i = 0;
  for (const [value, list] of buckets) {
    const color = value === '(missing)' ? [0.4, 0.4, 0.45, 1] as ColorTuple : PALETTE[i++ % PALETTE.length];
    const c = new THREE.Color(color[0], color[1], color[2]);
    for (const r of list) {
      (r.mesh.material as THREE.MeshStandardMaterial).color.copy(c);
      r.baseColor.copy(c);
    }
    legend.push({ value, count: list.length, color });
  }
  return { legend };
}
