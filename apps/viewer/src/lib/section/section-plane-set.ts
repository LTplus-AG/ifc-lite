/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pure half of the cutting-plane set (#7545): identity, naming, and what
 * counts as "no plane yet". The store slice (`sectionPlaneSetSlice.ts`) owns
 * the state; nothing here reads it.
 *
 * The set is the ACTIVE plane (`sectionPlane`, which every drawing, PDF, BCF
 * and alignment reader already treats as "the cut") plus the inactive ones.
 * The active plane is always present: a fresh viewer holds an untouched
 * placeholder, which is what "no cuts" means.
 */

import { MAX_EXTRA_CLIP_PLANES } from '@ifc-lite/renderer';
import type { SectionPlane } from '@/store/types';
import { SECTION_PLANE_DEFAULTS } from '@/store/constants';

/** The renderer clips against the active plane plus this many more. */
export const MAX_SECTION_PLANES = MAX_EXTRA_CLIP_PLANES + 1;

const NAME_MAX_LENGTH = 24;
const ID_PREFIX = 'section-plane-';
let idCounter = 0;

/** A session-unique id. Monotonic, so the numeric suffix is also the creation order. */
export function newSectionPlaneId(): string {
  idCounter += 1;
  return `${ID_PREFIX}${idCounter}`;
}

function idOrder(id: string): number {
  const n = Number(id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : NaN);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** `A`…`Z`, then `A2`…`Z2`, `A3`…: the first name not in `taken` (case-insensitive). */
export function nextSectionPlaneName(taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  for (let round = 1; ; round++) {
    for (let i = 0; i < 26; i++) {
      const name = `${String.fromCharCode(65 + i)}${round === 1 ? '' : round}`;
      if (!used.has(name.toLowerCase())) return name;
    }
  }
}

/** A user-typed name made valid: trimmed, bounded, and unique among `taken` (a clash gets ` 2`, ` 3`…). Null when empty. */
export function uniqueSectionPlaneName(desired: string, taken: readonly string[]): string | null {
  const base = desired.trim().slice(0, NAME_MAX_LENGTH).trim();
  if (!base) return null;
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${base.slice(0, NAME_MAX_LENGTH - suffix.length).trim()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The name a plane takes the moment a cut is first made on it. A fresh viewer
 * holds an UNNAMED placeholder (empty name), and every writer that turns it
 * into a cut names it with this, so "has a name" is "the user has a plane".
 */
export const FIRST_SECTION_PLANE_NAME = 'A';

/** True for the placeholder: no name yet, not cutting, nothing picked. Nothing to lose by replacing it. */
export function isPristineSectionPlane(plane: SectionPlane): boolean {
  return !plane.name && !plane.enabled && !plane.parked && !plane.custom && !plane.box;
}

/** A fresh plane carrying the cut-surface appearance of `style` (cap style is one user preference, not per plane). */
export function createSectionPlane(name: string, style: Pick<SectionPlane, 'showCap' | 'showOutlines' | 'capStyle'>): SectionPlane {
  return {
    id: newSectionPlaneId(),
    name,
    axis: SECTION_PLANE_DEFAULTS.AXIS,
    position: SECTION_PLANE_DEFAULTS.POSITION,
    enabled: SECTION_PLANE_DEFAULTS.ENABLED,
    flipped: SECTION_PLANE_DEFAULTS.FLIPPED,
    showGizmo: true,
    showCap: style.showCap,
    showOutlines: style.showOutlines,
    capStyle: style.capStyle,
  };
}

/** Every plane in creation order, whichever is active. */
export function orderedSectionPlanes(active: SectionPlane, inactive: readonly SectionPlane[]): SectionPlane[] {
  return [active, ...inactive].sort((a, b) => idOrder(a.id) - idOrder(b.id));
}

/** How many cuts the user has made: the untouched placeholder is none. */
export function sectionPlaneCount(active: SectionPlane, inactive: readonly SectionPlane[]): number {
  return inactive.length === 0 && isPristineSectionPlane(active) ? 0 : 1 + inactive.length;
}
