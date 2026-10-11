/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { AnchorEntityReader } from '../../../../../packages/create/src/in-store/resolve-anchor.js';
import { nativeGridExpected } from './model-authoring-grid-native';
import type { GridExpected } from './model-authoring-grid-fields';

export interface NativeGridEvidence {
  status: 'available' | 'unavailable';
  units: 'm';
  storeyExpressId: number | null;
  axisCount: number | null;
  expected: GridExpected | null;
}
/** Non-root axes keep native expressId and AxisTag; no fabricated stable GUIDs (#7304). */
export function nativeGridEvidence(target: ModelEditTarget | null, expressId: number): NativeGridEvidence | null {
  if (!target || target.editor.getEntityType(expressId)?.toUpperCase() !== 'IFCGRID') return null;
  const storeyExpressId = effectiveStoreyId(target.dataStore, target.view, expressId) ?? null;
  const root = new AnchorEntityReader(target.dataStore, target.view).entity(expressId);
  let axisCount: number | null = root ? 0 : null;
  if (root) for (const index of [7, 8, 9]) {
    const row = root.attributes[index];
    if (row !== null && row !== undefined && !Array.isArray(row)) { axisCount = null; break; }
    if (Array.isArray(row)) axisCount! += row.length;
  }
  const expected = storeyExpressId === null ? null : nativeGridExpected(target, expressId, storeyExpressId);
  return { status: expected ? 'available' : 'unavailable', units: 'm', storeyExpressId, axisCount, expected };
}
