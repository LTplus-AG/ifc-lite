/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BCF export's "Export complete!" progress clears itself after a short
 * delay. That delayed clear belongs to the run that scheduled it: a second
 * export started inside the window must keep its own progress, not lose it to
 * the first run's timer while the dialog is still busy.
 */

import '@/test/setup-dom.js';
import '@/test/download-capture.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { act } from 'react';
import type { ValidationReport } from '@ifc-lite/ids';
import { render, cleanup, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import type { IDSBCFExportSettings } from '@/components/viewer/IDSExportDialog';
import { useValidationExports } from './useValidationExports';

const initial = useViewerStore.getState();
beforeEach(() => { useActivityJournal.setState({ jobs: [] }); useViewerStore.setState(initial); });
afterEach(() => { cleanup(); useActivityJournal.setState({ jobs: [] }); useViewerStore.setState(initial); });

function report(): ValidationReport {
  return {
    source: { kind: 'rules', ruleSet: { name: 'Naming' } },
    timestamp: new Date('2026-11-09T00:00:00Z'), modelInfo: [],
    summary: { totalSpecifications: 1, passedSpecifications: 0, failedSpecifications: 1,
      totalEntitiesChecked: 1, totalEntitiesPassed: 0, totalEntitiesFailed: 1, overallPassRate: 0 },
    specificationResults: [{
      specification: { id: 'name', name: 'Walls are named' }, status: 'fail',
      applicableCount: 1, passedCount: 0, failedCount: 1, passRate: 0,
      entityResults: [{
        modelId: 'm', expressId: 10, globalId: '2O2Fr$t4X7Zf8NOew3FL01', entityType: 'IfcWall', passed: false,
        requirementResults: [{ requirement: { id: 'n', label: 'Name', optionality: 'required' },
          status: 'fail', facetType: 'attribute', checkedDescription: 'Name must be set' }],
      }],
    }],
  };
}

// No camera and no snapshots: the export needs no renderer, so it finishes in
// well under the 2 s completion window.
const settings: IDSBCFExportSettings = {
  topicGrouping: 'per-entity', includePassingEntities: false,
  includeCamera: false, includeSnapshots: false, loadIntoBcfPanel: false,
};

let owner: ReturnType<typeof useValidationExports>;
function Owner({ value }: { value: ValidationReport }) {
  owner = useValidationExports(value, 'en');
  return null;
}

it('a second BCF export inside the completion window keeps its progress past the first run\'s clear (B1)', async () => {
  const value = report();
  render(<Owner value={value} />);

  await act(async () => { await owner.exportReportBCF(settings); });
  assert.equal(owner.bcfExportProgress?.phase, 'done', 'the first run reports completion');

  // Start the second export 1.2 s into the first run's 2 s completion window.
  await advance(1200);
  await act(async () => { await owner.exportReportBCF(settings); });
  assert.equal(owner.bcfExportProgress?.phase, 'done', 'the second run reports completion');

  // Past the first run's deadline, inside the second run's own window.
  await advance(1200);
  assert.equal(owner.bcfExportProgress?.phase, 'done',
    'the first run\'s timer must not clear the second run\'s progress');

  // The second run's own clear still happens.
  await advance(1200);
  assert.equal(owner.bcfExportProgress, null, 'the second run clears its own completion');
});
