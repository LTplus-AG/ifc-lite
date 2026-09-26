/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { emptyPlacementState, importPlacements, rotatePlacements } from '@/lib/model-placement/state';
import { analysisStampOf, captureAnalysisStamp, stampAnalysisReport, useAnalysisStaleness } from './useAnalysisStaleness.js';

const initial = useViewerStore.getState();

function Probe({ report }: { report: object }) {
  return <span>{useAnalysisStaleness(analysisStampOf(report)) ? 'stale' : 'current'}</span>;
}

afterEach(() => {
  cleanup();
  useViewerStore.setState(initial, true);
});

it('#5820 marks a stamped report stale on an edit and current after a re-run', () => {
  useViewerStore.setState({ mutationVersion: 10, geometryContentVersion: 20 });
  const report = stampAnalysisReport({}, captureAnalysisStamp());
  const ui = render(<Probe report={report} />);
  assert.equal(ui.textContent, 'current');

  act(() => useViewerStore.setState({ mutationVersion: 11 }));
  assert.equal(ui.textContent, 'stale');

  const rerun = stampAnalysisReport({}, captureAnalysisStamp());
  cleanup();
  const updated = render(<Probe report={rerun} />);
  assert.equal(updated.textContent, 'current');

  act(() => useViewerStore.setState({ geometryContentVersion: 21 }));
  assert.equal(updated.textContent, 'stale');
});

for (const count of [1, 2]) it(`#5820 marks a Clash report stale when a model moves (${count} models)`, () => {
  const models = count === 1 ? fixtureModels(fixtureModel('a')) : fixtureModels(fixtureModel('a'), fixtureModel('b'));
  useViewerStore.setState({ ...models, modelPlacement: emptyPlacementState(), mutationVersion: 0, geometryContentVersion: 0 });
  const report = stampAnalysisReport({}, captureAnalysisStamp(true));
  const ui = render(<Probe report={report} />);
  assert.equal(ui.textContent, 'current');

  const moved = importPlacements(emptyPlacementState(), new Map([[
    count === 1 ? 'a' : 'b', { translation: [1, 0, 0] as [number, number, number], locked: false },
  ]]));
  act(() => useViewerStore.setState({ modelPlacement: moved }));
  assert.equal(ui.textContent, 'stale');

  act(() => useViewerStore.setState({ modelPlacement: emptyPlacementState() }));
  assert.equal(ui.textContent, 'current', 'undoing a placement restores the original analysis frame');

  act(() => useViewerStore.setState({ modelPlacement: rotatePlacements(emptyPlacementState(), ['a'], {
    angle: 0.5, pivot: [0, 0, 0],
  }) }));
  assert.equal(ui.textContent, 'stale', 'rotation changes clash geometry too');
});
