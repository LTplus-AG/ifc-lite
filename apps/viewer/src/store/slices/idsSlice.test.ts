/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `idsSlice` is one of the 17 slices in #2802 with zero test references.
 *
 * The property pinned here: every path that invalidates
 * `idsValidationReport` must reset `idsIsolateMode` the same way.
 * `clearIdsValidationReport` already did this. `setIdsDocument` (loading a
 * new document) and `clearIdsDocument` also null out `idsValidationReport`
 * and the failed/passed id caches — but, before this fix, left
 * `idsIsolateMode` untouched. Since the isolate-panel "pressed" state and
 * the 3D isolation built by `useIDS.ts` both key off `idsIsolateMode`, a
 * user who isolated failed entities and then loaded a new IDS document (or
 * cleared it) kept seeing the isolate button as active for a report that no
 * longer existed — the same "dangling pointer survives a sibling delete"
 * shape as the `lensSlice.deleteLens` defect from #2765.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import type { IDSValidationReport } from '@ifc-lite/ids';
import { createIdsSlice, type IDSSlice } from './idsSlice.js';

const make = () => createStore<IDSSlice>(createIdsSlice);

const report = (): IDSValidationReport =>
  ({
    specificationResults: [
      {
        specification: { id: 'spec1' },
        entityResults: [
          { modelId: 'm1', expressId: 1, passed: false },
          { modelId: 'm1', expressId: 2, passed: true },
        ],
      },
    ],
  }) as unknown as IDSValidationReport;

describe('idsSlice: clearing the report resets idsIsolateMode consistently', () => {
  it('clearIdsValidationReport resets idsIsolateMode (the known-good sibling)', () => {
    const s = make();
    s.getState().setIdsValidationReport(report());
    s.getState().setIdsIsolateMode('failed');

    s.getState().clearIdsValidationReport();

    assert.equal(s.getState().idsIsolateMode, null);
  });

  it('clearIdsDocument resets idsIsolateMode the same way', () => {
    const s = make();
    s.getState().setIdsValidationReport(report());
    s.getState().setIdsIsolateMode('failed');

    s.getState().clearIdsDocument();

    assert.equal(s.getState().idsValidationReport, null);
    assert.equal(
      s.getState().idsIsolateMode,
      null,
      'stale isolate mode must not survive clearing the document'
    );
  });

  it('setIdsDocument (loading a new document) resets idsIsolateMode the same way', () => {
    const s = make();
    s.getState().setIdsValidationReport(report());
    s.getState().setIdsIsolateMode('involved');

    s.getState().setIdsDocument({ specifications: [] } as never);

    assert.equal(s.getState().idsValidationReport, null);
    assert.equal(
      s.getState().idsIsolateMode,
      null,
      'stale isolate mode must not survive loading a new document'
    );
  });
});
