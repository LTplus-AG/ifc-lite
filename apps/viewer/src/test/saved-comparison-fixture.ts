/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Three revisions with intentionally different change sets, computed by the real diff engine. */
import { diffModels, type EntityFingerprint } from '@ifc-lite/diff';
import type { CompareRef } from '@/lib/compare/buildFingerprints';
import type { CompareResult } from '@/store/slices/compareSlice';
import { fixtureModel } from './store-fixture';

const revisions: Record<string, Array<[string, string]>> = {
  A: [['wall', 'v1'], ['removed', 'v1']],
  B: [['wall', 'v2'], ['new', 'v1']],
  C: [['wall', 'v2'], ['new', 'v2'], ['third', 'v1']],
};
export const comparisonModels = () => new Map(Object.keys(revisions).map((id) => [id, fixtureModel(id)]));
export function comparisonResult(base: string, head: string): CompareResult {
  const fingerprints = (modelId: string): EntityFingerprint<CompareRef>[] => revisions[modelId].map(([key, dataHash], i) => ({
    key, dataHash, ifcType: 'IfcWall', ref: { modelId, localId: i + 1, globalId: i + 1 },
  }));
  return { baseModelId: base, headModelId: head, baseName: base, headName: head, scope: 'data',
    geometryUnavailable: false, excludedHiddenIds: new Set(), mutationVersion: 0,
    diff: diffModels(fingerprints(base), fingerprints(head), { scope: 'data' }),
  };
}
