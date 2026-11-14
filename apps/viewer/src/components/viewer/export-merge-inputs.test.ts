/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `emptyMergeRefusal`, the sentence a merged export refuses with when the
 * hydration turned up nothing writable.
 *
 * Why it is pinned here and not through the dialog: `canWriteIfcFromStores`
 * disables the Export button for a federation with no writable store, so
 * `ExportDialog.empty-merge.test.tsx` can only click a disabled button and
 * proves the GATE. The function behind it fires one case further on — the
 * last writable store disappearing between the render that enabled the
 * button and the hydration inside the handler — which the suite cannot drive,
 * because the dialog reads its models from the same store the hydration does
 * and React re-renders on any change to it.
 *
 * So the wiring is a backstop no test exercises, and that is stated rather
 * than rounded up. What IS pinned here is that the function answers for both
 * inputs, so it cannot quietly become a no-op.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MergeModelInput } from '@ifc-lite/export';
import { emptyMergeRefusal } from './export-merge-inputs';

/** The real catalogue's sentence, so a reworded key fails here too. */
const t = ((key: string) => (key === 'exportDialog.noStepRecords.error'
  ? 'This model has no IFC records to write from. Choose IFC5 to export it as IFCX.'
  : `!!${key}!!`)) as Parameters<typeof emptyMergeRefusal>[1];

describe('emptyMergeRefusal', () => {
  it('refuses an empty input list with the dialog sentence, not MergedExporter\'s invariant', () => {
    const message = emptyMergeRefusal([], t);
    assert.match(String(message), /no IFC records to write from/);
    assert.doesNotMatch(String(message), /requires at least one model/,
      'the owner never reads MergedExporter\'s internal precondition');
  });

  it('says nothing about models left out, because with no inputs that is all of them', () => {
    // The notice would name the whole federation under "Left out of the
    // merged file" when no merged file exists, after a sentence that already
    // said there are no records.
    assert.doesNotMatch(String(emptyMergeRefusal([], t)), /Left out of the merged file/);
  });

  it('passes a merge with one writable model straight through', () => {
    const input = { id: 'a', name: 'tower.ifc' } as unknown as MergeModelInput;
    assert.equal(emptyMergeRefusal([input], t), null);
  });
});
