/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { render, click, cleanup } from '@/test/render';
import { fixtureModels } from '@/test/store-fixture';
import { revisionPair, runClash, PINS } from '@/lib/compare/revision-pair.test-support';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { selectChangedEntity } from '@/lib/changes/select-changed-entity';
import { CompareAnalysisSections } from './CompareAnalysisSections';
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
it('native revision-pair control selects the added duct in its owning head model', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: pair.compare });
 const id = pair.head.ifcDataStore.entities.getExpressIdByGlobalId(PINS.clashAdded);
 assert.ok(id > 0, 'real revision fixture contains its pinned added duct');
 assert.equal(selectChangedEntity(pair.head.id, id), true);
 assert.equal(useViewerStore.getState().selectedEntity?.modelId, pair.head.id);
 assert.equal(useViewerStore.getState().selectedEntity?.expressId, id);
 assert.equal(pair.head.ifcDataStore.entities.getGlobalId(id), PINS.clashAdded);
});
it('impact row exposes native navigation for the real changed duct clash', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: pair.compare });
 const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), captureAnalysisStamp());
 act(() => useViewerStore.setState({ clashResult: clash, clashRawResult: clash }));
 const root = render(<CompareAnalysisSections result={pair.compare} />);
 const toggle = [...root.querySelectorAll('button')].find(b => /Impact on other analyses/.test(b.textContent ?? ''));
 assert.ok(toggle); act(() => click(toggle));
 const row = [...root.querySelectorAll('li')].find(li => li.textContent?.includes(PINS.clashAdded));
 assert.ok(row, 'native clash engine joined the pinned added duct to the actual comparison');
 assert.ok(row.querySelector('button, a[href]'), 'the impacted native finding or changed entity has an accessible navigation action');
});
