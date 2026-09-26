/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5816: once a report is on screen the IDS panel offers Re-run, and "clear
 * results" is separate from "unload IDS".
 *
 * Before the fix the only Run button vanished as soon as a report existed and
 * the one Trash button also unloaded the document, so re-checking after an
 * edit meant reloading the `.ids` file.
 *
 * Re-run must validate the model the REPORT describes, not whichever model is
 * active: with N models loaded those differ, and a re-run that silently
 * switched models would put a different model's result under the same header.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { installLayout } from '@/test/dom-layout.js';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import type { IDSDocument, IDSValidationReport } from '@ifc-lite/ids';
import { IDSPanel } from './IDSPanel.js';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';

const initial = useViewerStore.getState();
installLayout();

const documentFixture: IDSDocument = {
  info: { title: 'Fixture IDS', version: '1.0' },
  specifications: [{
    id: 'spec-a',
    name: 'Wall requirements',
    ifcVersions: ['IFC4'],
    applicability: { facets: [] },
    requirements: [],
  }],
};

function reportFor(modelId: string): IDSValidationReport {
  return {
    source: { kind: 'ids', document: documentFixture },
    modelInfo: [{ modelId, schemaVersion: 'IFC4', entityCount: 1 }],
    timestamp: new Date(0),
    summary: {
      totalSpecifications: 1, passedSpecifications: 0, failedSpecifications: 1,
      totalEntitiesChecked: 1, totalEntitiesPassed: 0, totalEntitiesFailed: 1, overallPassRate: 0,
    },
    specificationResults: [{
      specification: documentFixture.specifications[0],
      status: 'fail', applicableCount: 1, passedCount: 0, failedCount: 1, passRate: 0,
      entityResults: [{ expressId: 1, modelId, entityType: 'IfcWall', entityName: 'Wall A', passed: false, requirementResults: [] }],
    }],
  };
}

function button(ui: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...ui.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;
}

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({
    ...initial,
    idsDocument: null,
    idsValidationReport: null,
    idsAuditReport: null,
    idsError: null,
    idsLoading: false,
    idsProgress: null,
  });
});

describe('IDSPanel re-run and split clear (#5816)', () => {
  for (const modelCount of [1, 2] as const) {
    it(`#5820 keeps a stale report visible with a Re-run banner (${modelCount} model(s))`, () => {
      const models = modelCount === 1
        ? fixtureModels(fixtureModel('model-a', { entities: [{ expressId: 1, type: 'IfcWall' }] }))
        : fixtureModels(
          fixtureModel('model-a', { entities: [{ expressId: 1, type: 'IfcWall' }] }),
          fixtureModel('model-b', { idOffset: 100, entities: [{ expressId: 1, type: 'IfcWall' }] }),
        );
      useViewerStore.setState({ ...models, idsDocument: documentFixture, mutationVersion: 10, geometryContentVersion: 20 });
      const report = stampAnalysisReport(reportFor('model-a'), captureAnalysisStamp());
      useViewerStore.setState({ idsValidationReport: report });
      const ui = render(<IDSPanel />);

      act(() => useViewerStore.setState({ mutationVersion: 11 }));
      assert.equal(useViewerStore.getState().idsValidationReport, report);
      assert.match(ui.textContent ?? '', /model changed/i);
      const bannerRerun = [...ui.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Re-run');
      assert.ok(bannerRerun);
      assert.ok(ui.querySelector('.opacity-60'), 'the old result is dimmed');
      if (modelCount === 1) {
        // Make the target temporarily unavailable so the banner action has a
        // distinct observable outcome without running a fake parser fixture.
        const model = useViewerStore.getState().models.get('model-a');
        assert.ok(model);
        act(() => useViewerStore.setState({ models: new Map([['model-a', { ...model, ifcDataStore: null }]]) }));
        click(bannerRerun);
        assert.deepEqual(useViewerStore.getState().idsError, { labelKey: 'idsPanel.error.modelNoData' });
      }
    });
  }

  it('offers Re-run while a report is on screen, targeting the report model (1 model)', () => {
    // No model loaded: a re-run that names the report's model fails with
    // "model-a is not loaded"; one that fell back to the active model would
    // report "no model loaded" instead.
    useViewerStore.setState({ idsDocument: documentFixture, idsValidationReport: reportFor('model-a') });
    const ui = render(<IDSPanel />);
    const rerun = button(ui, 'Re-run validation');
    assert.ok(rerun, 'Re-run is offered once a report exists');
    assert.equal(rerun.disabled, false);
    click(rerun);
    assert.deepEqual(useViewerStore.getState().idsError, {
      labelKey: 'idsPanel.error.modelNotLoaded', params: { modelId: 'model-a' },
    });
  });

  it('re-runs against the report model, not the active one (N models)', () => {
    // The active model has parsed data; the report's model (second, offset
    // ids) has none. Targeting the report model fails with "no parsed data";
    // a re-run that fell back to the active model would validate model-b.
    const federation = fixtureModels(
      fixtureModel('model-b', { entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall B' }] }),
      { ...fixtureModel('model-a', { idOffset: 100 }), ifcDataStore: null },
    );
    assert.equal(federation.activeModelId, 'model-b');
    useViewerStore.setState({ ...federation, idsDocument: documentFixture, idsValidationReport: reportFor('model-a') });
    const ui = render(<IDSPanel />);
    const rerun = button(ui, 'Re-run validation');
    assert.ok(rerun);
    click(rerun);
    assert.deepEqual(useViewerStore.getState().idsError, { labelKey: 'idsPanel.error.modelNoData' });
  });

  it('clears results but keeps the IDS document loaded', () => {
    useViewerStore.setState({ idsDocument: documentFixture, idsValidationReport: reportFor('model-a') });
    const ui = render(<IDSPanel />);
    const clear = button(ui, 'Clear results');
    assert.ok(clear, 'Clear results is offered once a report exists');
    click(clear);
    const state = useViewerStore.getState();
    assert.equal(state.idsValidationReport, null);
    assert.equal(state.idsDocument, documentFixture, 'the document survives clearing results');
    assert.match(ui.textContent ?? '', /Run Validation/, 'back on the pre-run card');
  });

  it('unloads the IDS document and its results together', () => {
    useViewerStore.setState({ idsDocument: documentFixture, idsValidationReport: reportFor('model-a') });
    const ui = render(<IDSPanel />);
    const unload = button(ui, 'Unload IDS');
    assert.ok(unload);
    click(unload);
    const state = useViewerStore.getState();
    assert.equal(state.idsValidationReport, null);
    assert.equal(state.idsDocument, null);
  });

  it('offers neither Re-run nor Clear results before the first run', () => {
    useViewerStore.setState({ idsDocument: documentFixture, idsValidationReport: null });
    const ui = render(<IDSPanel />);
    assert.equal(button(ui, 'Re-run validation'), undefined);
    assert.equal(button(ui, 'Clear results'), undefined);
    assert.ok(button(ui, 'Unload IDS'));
  });
});
