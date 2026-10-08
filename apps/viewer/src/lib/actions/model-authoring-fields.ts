/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Field parsers of the reviewed authoring contract (`model-authoring.ts`): bounded, unit-aware, with actionable messages. */

export interface LengthRange { min: number; max: number; signed?: boolean }

export const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function parseText(value: unknown, at: string, max = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`${at} must be text of 1–${max} characters`);
  return value.trim();
}

/** `{globalId, modelId?}`: a 22-character IFC GlobalId, optionally pinned to one loaded model. */
export function parseGlobalIdTarget(value: unknown, at: string): { globalId: string; modelId?: string } {
  if (!record(value) || typeof value.globalId !== 'string' || !/^[0-9A-Za-z_$]{22}$/.test(value.globalId)) {
    throw new Error(`${at} needs a 22-character IFC GlobalId`);
  }
  if (value.modelId !== undefined && typeof value.modelId !== 'string') throw new Error(`${at}: a model id must be text`);
  return { globalId: value.globalId, ...(typeof value.modelId === 'string' ? { modelId: value.modelId } : {}) };
}

export function parseRef(value: unknown, at: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(value)) throw new Error(`${at} needs a ref: a short name such as "wall-1"`);
  return value;
}

const metres = (units: 'm' | 'mm', value: number) => units === 'mm' ? value / 1000 : value;

/**
 * A length in the batch's `units`, kept in those units. Its metre value must
 * lie in `range`: the builders' plausible span, so 200 under `"units": "m"`
 * for a wall thickness is refused as a probable unit mistake, not written.
 */
export function parseLength(value: unknown, units: 'm' | 'mm', range: LengthRange, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${at} must be a number in ${units}`);
  const m = metres(units, value);
  if (m < range.min || m > range.max) {
    const span = `${range.min}–${range.max} m`;
    throw new Error(`${at} is ${value} ${units}, outside ${span}${range.signed ? '' : '; check the declared "units"'}`);
  }
  return value;
}

export function parsePoint(value: unknown, units: 'm' | 'mm', range: LengthRange, at: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${at} must be [x, y, z] in ${units}, storey-local`);
  return value.map((v, i) => parseLength(v, units, range, `${at}[${i}]`)) as [number, number, number];
}
