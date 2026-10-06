/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { WORKSPACE_PANELS } from '@/lib/panels/registry';
import { resolveEnglish } from '@/i18n/registry';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ASSISTANT_SOURCES } from '../sources';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { ADAPTERS, UNSUPPORTED_PANELS, adapterFor, panelSource } from './registry';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

// #6833 charter: every source has exactly one adapter, and no panel is silently omitted.
test('every assistant source has exactly one registered adapter', () => {
  assert.deepEqual(ADAPTERS.map(adapter => adapter.id).sort(), [...ASSISTANT_SOURCES].sort());
  for (const source of ASSISTANT_SOURCES) assert.equal(adapterFor(source).id, source);
});

test('every workspace panel is either discussable through an adapter or an explained boundary', () => {
  for (const panel of WORKSPACE_PANELS) {
    const mapped = ADAPTERS.some(adapter => adapter.panelIds.includes(panel.id));
    const boundary = UNSUPPORTED_PANELS[panel.id];
    assert.ok(mapped !== (boundary !== undefined), `${panel.id} must be exactly one of mapped or boundary`);
    if (boundary) assert.notEqual(resolveEnglish(boundary), boundary, `${panel.id} boundary reason is catalogued`);
  }
});

test('adapter copy resolves through the English catalogue', () => {
  for (const adapter of ADAPTERS) {
    for (const key of [adapter.titleKey, adapter.descriptionKey, adapter.rowMeaningKey, adapter.unavailableKey, ...adapter.suggestionKeys]) {
      const text = resolveEnglish(key);
      assert.ok(text && text !== key, `${adapter.id}: ${key} resolves`);
    }
    assert.ok(adapter.suggestionKeys.length > 0, `${adapter.id} offers a starting question`);
  }
});

// With no native result anywhere, every adapter must say "unavailable" or "empty",
// never fabricate rows, and its readiness must agree with what capture returns.
test('an empty viewer captures every source as unavailable or empty with consistent readiness and freshness', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  for (const adapter of ADAPTERS) {
    const state = useViewerStore.getState();
    const readiness = adapter.readiness(state);
    const snapshot = captureEvidence(adapter.id);
    const payload = JSON.parse(snapshot.payload);
    assert.ok(payload.sourceAvailability === 'available' || payload.sourceAvailability === 'unavailable', adapter.id);
    assert.equal(payload.includedRows, payload.evidence.rows.length, adapter.id);
    assert.ok(snapshot.includedRows <= snapshot.totalRows, adapter.id);
    if (payload.sourceAvailability === 'unavailable') {
      assert.equal(snapshot.totalRows, 0, `${adapter.id}: an unavailable source has no rows`);
      assert.equal(readiness.ready, false, `${adapter.id}: unavailable sources are not offered for discussion`);
    }
    assert.equal(evidenceIsCurrent(snapshot), true, `${adapter.id}: fresh capture is current`);
    useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
    assert.equal(evidenceIsCurrent(snapshot), false, `${adapter.id}: an edit invalidates the snapshot`);
  }
});

test('panels hosting several sources resolve to exactly one current subject', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  const state = useViewerStore.getState();
  for (const panel of WORKSPACE_PANELS) {
    const source = panelSource(panel.id, state);
    if (UNSUPPORTED_PANELS[panel.id]) assert.equal(source, null, `${panel.id} is a boundary`);
    else if (source) assert.ok(adapterFor(source).panelIds.includes(panel.id));
  }
  assert.equal(panelSource('clash', state), 'clash');
  assert.equal(panelSource('loadReport', state), 'loadReport');
  assert.equal(panelSource(null, state), null);
});
