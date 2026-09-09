/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Workspace translations use metres, engineering X/Y/Z (Z is elevation).
 * These are interaction calculations, not IFC georeference conversions. */
export type Translation = readonly [number, number, number];
export type MoveConstraint = 'free' | 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz';
export const ZERO_TRANSLATION: Translation = Object.freeze([0, 0, 0]);

export function finiteTranslation(value: unknown): value is Translation {
  return Array.isArray(value) && value.length === 3 && value.every(
    (coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate),
  );
}

export function assertRenderableTranslation(value: Translation): void {
  if (!finiteTranslation(value) || !value.every((coordinate) => Number.isFinite(Math.fround(coordinate)))) {
    throw new Error('Position exceeds the renderable coordinate range.');
  }
}

export function addTranslation(a: Translation, b: Translation): Translation {
  const result: Translation = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  if (!finiteTranslation(result)) throw new Error('Position is outside the finite coordinate range.');
  return result;
}

export function subtractTranslation(a: Translation, b: Translation): Translation {
  return addTranslation(a, [-b[0], -b[1], -b[2]]);
}

export function equalTranslation(a: Translation, b: Translation): boolean {
  return a.every((v, index) => v === b[index]);
}

/** Constraints are authoritative: snapping cannot reintroduce a locked component. */
export function constrainTranslation(delta: Translation, constraint: MoveConstraint): Translation {
  if (constraint === 'free') return delta;
  return [constraint.includes('x') ? delta[0] : 0,
    constraint.includes('y') ? delta[1] : 0, constraint.includes('z') ? delta[2] : 0];
}

/** Temporary Shift-ortho with hysteresis; only axes allowed by the plane can win. */
export function orthogonalAxis(
  delta: Translation, constraint: MoveConstraint, previous?: 'x' | 'y' | 'z',
): 'x' | 'y' | 'z' {
  const axes = ['x', 'y', 'z'] as const;
  const allowed = axes.filter((axis) => constraint === 'free' || constraint.includes(axis));
  const magnitude = (axis: typeof axes[number]) => Math.abs(delta[axes.indexOf(axis)]);
  const best = allowed.reduce((a, b) => magnitude(b) > magnitude(a) ? b : a);
  return previous && allowed.includes(previous) && magnitude(previous) * 1.2 >= magnitude(best)
    ? previous : best;
}

/** Positive distance follows the established direction; a signed value reverses it. */
export function translationAtDistance(direction: Translation, distance: number): Translation {
  const length = Math.hypot(...direction);
  if (!Number.isFinite(distance) || !Number.isFinite(length) || length === 0) {
    throw new Error('Choose an axis or direction before entering a distance.');
  }
  return [direction[0] === 0 ? 0 : direction[0] / length * distance,
    direction[1] === 0 ? 0 : direction[1] / length * distance,
    direction[2] === 0 ? 0 : direction[2] / length * distance];
}

const LENGTH_UNITS: Readonly<Record<string, number>> = {
  mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048,
};

/** Full-string parsing; no executable expressions, grouping separators or trailing junk.
 * A decimal comma is accepted when it is the sole decimal separator. */
export function parseMoveLength(text: string, defaultUnit = 'm'): number {
  const match = /^\s*([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?)\s*(mm|cm|km|m|in|ft)?\s*$/i.exec(text);
  if (!match) throw new Error('Enter a number with an optional unit: mm, cm, m, km, in, or ft.');
  const scale = LENGTH_UNITS[(match[2] ?? defaultUnit).toLowerCase()];
  const result = Number(match[1].replace(',', '.')) * scale;
  if (!Number.isFinite(result)) throw new Error('Enter a finite distance with a supported unit.');
  return result;
}

export function toRenderTranslation(value: Translation): [number, number, number] {
  return [value[0], value[2], -value[1]];
}

export function fromRenderTranslation(value: { x: number; y: number; z: number }): Translation {
  return [value.x, -value.z, value.y];
}
