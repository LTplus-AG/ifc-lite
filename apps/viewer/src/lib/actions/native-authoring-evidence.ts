/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { nativeReplacementEvidence } from './model-authoring-replacement';
import { nativeSlabOpeningEvidence } from './model-authoring-slab-opening';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { nativeLengthUnitAvailable } from './model-authoring-read-target';
import { readSplitSnapshot, type SplitSnapshot } from './model-authoring-split-state';
import { readExpectedHostedEdit, type ExpectedHostedEdit } from './model-authoring-hosted-edit';
import { authoringReachEvidenceFromTarget } from './model-authoring-reach';
import { nativeStairEvidenceFromTarget } from './model-authoring-stair-lifecycle';

type Availability = 'available' | 'unavailable-target' | 'unavailable-unit' | 'unavailable-native-layout' | 'unavailable-projection';
export interface NativeAuthoringEvidence {
  nativeReplacementExpected: ReturnType<typeof nativeReplacementEvidence>;
  nativeSplitExpected: SplitSnapshot | null;
  nativeSlabOpeningExpected: SplitSnapshot | null;
  nativeHostedExpected: ExpectedHostedEdit | null;
  nativeTrimExtendExpected: ReturnType<typeof authoringReachEvidenceFromTarget>;
  nativeStairExpected: ReturnType<typeof nativeStairEvidenceFromTarget>;
  nativeAuthoringUnits: { replacement: 'verbatim-native-fields'; slabOpening: 'm'; split: 'm'; hosted: 'm'; stair: 'm'; trimExtend: 'verbatim-native-fields' };
  nativeAuthoringRefusals: { split: string | null; hosted: string | null };
  /** Split/Hosted lengths are metres; Trim remains verbatim mixed native fields;
   * Stair follows the canonical SI dimension reader. No IDs are converted. */
  nativeAuthoringAvailability: {
    replacement: Availability;
    slabOpening: Availability;
    split: Availability;
    hosted: Availability;
    trimExtend: Availability;
    stair: Availability;
  };
}

/** #7282: one pure native producer for selected rows and explicit attachments.
 * Reads the detached per-model target supplied by the capture owner. */
export function nativeAuthoringEvidence(target: ModelEditTarget | null, expressId: number): NativeAuthoringEvidence {
  const unavailable: Availability = !target ? 'unavailable-target'
    : !nativeLengthUnitAvailable(target) ? 'unavailable-unit' : 'unavailable-native-layout';
  const refusals: NativeAuthoringEvidence['nativeAuthoringRefusals'] = { split: null, hosted: null };
  let split: SplitSnapshot | null = null;
  let hosted: ExpectedHostedEdit | null = null;
  let trim: NativeAuthoringEvidence['nativeTrimExtendExpected'] = null;
  let stair: NativeAuthoringEvidence['nativeStairExpected'] = null;
  if (target && unavailable === 'unavailable-native-layout') {
    const { dataStore, editor } = target;
    // These canonical readers refuse unsupported native layouts with Error.
    // Capture records unavailability; it never invents a reduced expected pin.
    try { split = readSplitSnapshot(dataStore, editor, expressId, 'm'); }
    catch (error) { if (!(error instanceof Error)) throw error; refusals.split = error.message; }
    try { hosted = readExpectedHostedEdit(dataStore, editor, expressId, 'm'); }
    catch (error) { if (!(error instanceof Error)) throw error; refusals.hosted = error.message; }
    trim = authoringReachEvidenceFromTarget(target, expressId);
    stair = nativeStairEvidenceFromTarget(target, expressId);
  }
  const slab=nativeSlabOpeningEvidence(target,expressId),replacement=nativeReplacementEvidence(target,expressId);
  return { nativeReplacementExpected: replacement, nativeSlabOpeningExpected: slab.expected, nativeSplitExpected: split, nativeHostedExpected: hosted,
    nativeTrimExtendExpected: trim, nativeStairExpected: stair,
    nativeAuthoringUnits: { replacement: 'verbatim-native-fields', slabOpening: 'm', split: 'm', hosted: 'm', stair: 'm', trimExtend: 'verbatim-native-fields' },
    nativeAuthoringRefusals: refusals,
    nativeAuthoringAvailability: { replacement: replacement ? 'available' : unavailable, slabOpening: slab.expected ? 'available' : unavailable, split: split ? 'available' : unavailable,
      hosted: hosted ? 'available' : unavailable, trimExtend: trim ? 'available' : unavailable,
      stair: stair ? 'available' : unavailable } };
}

const snapshotFields = [
  ['nativeReplacementExpected', 'replacement'],
  ['nativeSlabOpeningExpected', 'slabOpening'], ['nativeSplitExpected', 'split'], ['nativeHostedExpected', 'hosted'],
  ['nativeTrimExtendExpected', 'trimExtend'], ['nativeStairExpected', 'stair'],
] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The common evidence projection may bound arrays/depth/work. A partial native
 * expected pin cannot authorize review: remove it and disclose its unavailability. */
export function preserveNativeExpectedProjection(original: unknown, projected: unknown): void {
  if (!record(original) || !record(projected) || !record(original.data) || !record(projected.data)) return;
  let availability = projected.data.nativeAuthoringAvailability;
  for (const [field, family] of snapshotFields) {
    const expected = original.data[field];
    if (expected !== null && expected !== undefined && JSON.stringify(expected) !== JSON.stringify(projected.data[field])) {
      projected.data[field] = null;
      if (!record(availability)) {
        availability = record(original.data.nativeAuthoringAvailability) ? { ...original.data.nativeAuthoringAvailability } : {};
        projected.data.nativeAuthoringAvailability = availability;
      }
      if (record(availability)) availability[family] = 'unavailable-projection';
    }
  }
}
