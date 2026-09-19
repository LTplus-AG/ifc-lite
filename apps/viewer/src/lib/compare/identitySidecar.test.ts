/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACCEPTED_AMBIGUOUS_REASON,
  diffModels,
  type EntityFingerprint,
  type IdentityMapEntry,
} from '@ifc-lite/diff';
import type { CompareRef } from './buildFingerprints.js';
import { lineageForExport } from './identitySidecar.js';
import type { CompareResult } from '../../store/slices/compareSlice.js';

const ref: CompareRef = { modelId: 'model', localId: 1, globalId: 1, meshed: true };

function entity(key: string): EntityFingerprint<CompareRef> {
  return { key, ifcType: 'IfcWall', dataHash: key, geometryHash: key, ref };
}

function replayedResult(): CompareResult {
  return {
    baseModelId: 'base',
    headModelId: 'head',
    baseName: 'base.ifc',
    headName: 'head.ifc',
    scope: 'both',
    geometryUnavailable: false,
    excludedHiddenIds: new Set(),
    diff: diffModels([entity('OLD')], [entity('NEW')], {
      keyAliases: new Map([['NEW', 'OLD']]),
    }),
  };
}

describe('lineageForExport', () => {
  it('preserves the reviewed relation when an accepted alias is replayed (#4989)', () => {
    const accepted = (reason: string): IdentityMapEntry[] => [{ base: 'OLD', here: 'NEW', reason }];

    assert.deepEqual(lineageForExport(replayedResult(), accepted('reviewed replacement')).entries, [
      { base: ['OLD'], head: ['NEW'], relation: 'replaced', reason: 'reviewed replacement' },
    ]);
    assert.deepEqual(lineageForExport(replayedResult(), accepted(ACCEPTED_AMBIGUOUS_REASON)).entries, [
      { base: ['OLD'], head: ['NEW'], relation: 'identity', reason: ACCEPTED_AMBIGUOUS_REASON },
    ]);
  });
});
