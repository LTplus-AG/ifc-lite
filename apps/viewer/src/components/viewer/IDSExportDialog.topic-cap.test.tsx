/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5824: the IDS → BCF dialog defaulted to one topic per failing entity and
 * never said how many topics that makes, so a requirement failing on 5,000
 * walls (here split across two models) exported 1,000 topics plus a
 * "truncated" note with no warning. The default is now per specification,
 * and the dialog shows the count and warns above the cap.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { IDSReportInput } from '@ifc-lite/bcf';
import { cleanup, render } from '@/test/render.js';
import { IDSExportDialog, type IDSBCFExportSettings } from './IDSExportDialog.js';
import { IDSExportTopicCount } from './IDSExportTopicCount.js';

afterEach(cleanup);

/** One failing specification with 5,000 failing walls across two models. */
const RESULTS: IDSReportInput['specificationResults'] = [{
  specification: { name: 'Walls need fire rating' },
  status: 'fail', applicableCount: 5000, passedCount: 0, failedCount: 5000,
  entityResults: Array.from({ length: 5000 }, (_, i) => ({
    expressId: i + 1, modelId: i % 2 === 0 ? 'A' : 'B', entityType: 'IfcWall', passed: false,
    requirementResults: [{ status: 'fail' as const, facetType: 'property', checkedDescription: 'FireRating' }],
  })),
}];

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  assert.ok(found, `button "${label}" must render`);
  return found;
}

describe('IDSExportDialog topic cap (#5824)', () => {
  it('defaults to one topic per specification and says how many topics that is', async () => {
    const exported: IDSBCFExportSettings[] = [];
    render(
      <IDSExportDialog
        open onOpenChange={() => {}} hasReport failedCount={5000}
        specificationResults={RESULTS}
        onExport={async (settings) => { exported.push(settings); }}
        progress={null}
      />,
    );
    assert.match(document.body.textContent ?? '', /This export creates 1 BCF topic\./);
    await act(async () => { button('Export BCF').click(); });
    assert.equal(exported[0]?.topicGrouping, 'per-specification');
  });

  it('warns, with the numbers, when the grouping exceeds the cap', () => {
    const ui = render(<IDSExportTopicCount specificationResults={RESULTS} settings={{ topicGrouping: 'per-entity', includePassingEntities: false }} />);
    const alert = ui.querySelector('[role="alert"]');
    assert.ok(alert, 'above the cap the count is an alert');
    assert.match(alert.textContent ?? '', /makes 5,000 topics\. Only the first 1,000 are exported and 4,000 are left out/);
  });

  it('shows a plain count, not a warning, at or under the cap', () => {
    const ui = render(<IDSExportTopicCount specificationResults={RESULTS.map((s) => ({ ...s, entityResults: s.entityResults.slice(0, 1000) }))} settings={{ topicGrouping: 'per-entity', includePassingEntities: false }} />);
    assert.equal(ui.querySelector('[role="alert"]'), null);
    assert.match(ui.textContent ?? '', /This export creates 1,000 BCF topics\./);
  });
});
