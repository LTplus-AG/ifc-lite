/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { CurtainWallGridSpec } from './curtain-wall.js';

const PSET = 'IfcLite_CurtainWallLayout';

/** Metre offsets or a bay count, kept distinct even when they describe the same current rows. */
export function writeCurtainWallVGrid(view: MutablePropertyView, id: number, spec: CurtainWallGridSpec): void {
  view.setProperty(id, PSET, 'VGrid', JSON.stringify(spec), PropertyValueType.Label);
}

/** Undefined means an older file whose rows must be reconstructed from geometry. */
export function readCurtainWallVGrid(view: MutablePropertyView, id: number): CurtainWallGridSpec | undefined {
  const stored = view.getPropertyValue(id, PSET, 'VGrid');
  if (stored === null || stored === undefined) return undefined;
  const invalid = () => new Error('The recorded curtain-wall VGrid is not a bay count or increasing metre offsets');
  if (typeof stored !== 'string') throw invalid();
  let value: unknown;
  try { value = JSON.parse(stored); } catch (error) { throw new Error(invalid().message, { cause: error }); }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (Array.isArray(value) && value.every((n: unknown, i: number) => typeof n === 'number' && Number.isFinite(n)
    && n > 0 && (i === 0 || n > value[i - 1]))) return value as number[];
  throw invalid();
}
