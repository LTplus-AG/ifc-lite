/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compare fingerprints the models as edited, not as loaded (#5312, see
 * `effectiveCompareStore.ts` and `useCompare.liveEdits.test.tsx`). The #5312
 * warn-only notice that said the opposite ("Compare reads the file as loaded,
 * not those edits") outlived the fix; #5606 removed it. A dirty compared model
 * must not bring it back.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { advance, cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import { ComparePanel } from './ComparePanel.js';
import { fixtureModels } from '@/test/store-fixture.js';
import { revisionPair, runClash } from '@/lib/compare/revision-pair.test-support.js';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness.js';

function model(id: string): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 10,
  } as FederatedModel;
}

const initial = useViewerStore.getState();
const RESET_STATE = {
  ...initial,
  models: new Map(),
  compareBaseModelId: null,
  compareHeadModelId: null,
  compareResult: null,
  compareSelectedKey: null,
  compareRunning: false,
  compareError: null,
  dirtyModels: new Set<string>(),
};

beforeEach(() => {
  useViewerStore.setState(RESET_STATE, true);
});

afterEach(() => {
  cleanup();
  useViewerStore.setState(RESET_STATE, true);
});

describe('ComparePanel with unsaved edits (#5606)', () => {
  it('#6970: opens native impact rows through the actual Compare panel', async t => {
    const pair = await revisionPair(t);
    if (!pair) return;
    useViewerStore.setState({ ...fixtureModels(pair.base, pair.head),
      compareBaseModelId: pair.base.id, compareHeadModelId: pair.head.id,
      compareResult: pair.compare, compareRunCaptures: [], compareReconciliation: null });
    const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), captureAnalysisStamp());
    useViewerStore.setState({ clashResult: clash, clashRawResult: clash });
    const container = render(<ComparePanel onClose={() => {}} />);
    for (let attempt = 0; attempt < 200 && !container.textContent?.includes('Impact on other analyses'); attempt++) await advance(20);
    const toggle = [...container.querySelectorAll('button')].find(button => /Impact on other analyses/.test(button.textContent ?? ''));
    assert.ok(toggle, 'the panel exposes impact review for its comparison');
    act(() => click(toggle));
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.match(container.textContent ?? '', /Clashes2 touched/);
    assert.match(container.textContent ?? '', /3GwpRmJBf7fhCP8KgMyfOD · Added/);
  });

  it('does not claim Compare ignores the edits when a compared model is dirty', () => {
    useViewerStore.setState({
      models: new Map([
        ['A', model('A')],
        ['B', model('B')],
      ]),
      compareBaseModelId: 'A',
      compareHeadModelId: 'B',
      dirtyModels: new Set(['B']),
    });
    const container = render(<ComparePanel onClose={() => {}} />);
    const text = container.textContent ?? '';
    assert.doesNotMatch(text, /as loaded/, 'Compare reads the edited models, so no "reads the file as loaded" notice');
    assert.doesNotMatch(text, /unsaved viewer edits/);
  });
});
