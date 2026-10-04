/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { captureEvidence } from '@/lib/assistant/evidence';
import { EvidenceView } from './EvidenceView';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

// #6839: captured scope is independent of later workspace selection and text is inert.
test('historical load context retains captured model identity and explicit row meaning', () => {
  const name = '<img src=x onerror="globalThis.executed=true">.ifc';
  useViewerStore.setState(fixtureModels({ ...fixtureModel('captured'), name }));
  const evidence = captureEvidence('loadReport');
  useViewerStore.setState(fixtureModels({ ...fixtureModel('replacement'), name: 'Later model.ifc' }));
  const ui = render(<EvidenceView evidence={evidence} state="historical" />);
  assert.match(ui.textContent ?? '', /Historical evidence/);
  assert.match(ui.textContent ?? '', /Rows represent model load reports/);
  assert.match(ui.textContent ?? '', /Unavailable diagnostics are not clean loads/);
  assert.match(ui.textContent ?? '', /1 of 1 metadata entries/);
  assert.ok(ui.textContent?.includes(name));
  assert.ok(ui.textContent?.includes(evidence.payload));
  assert.doesNotMatch(ui.textContent ?? '', /Later model/);
  assert.equal(ui.querySelector('img'), null);
  assert.equal(ui.querySelector('time')?.getAttribute('datetime'), evidence.capturedAt);
});

test('large federation shows actual included metadata and omission instead of inventing complete scope', () => {
  useViewerStore.setState({ models: new Map(Array.from({ length: 120 }, (_, index) => {
    const model = { ...fixtureModel(`m${index}`), name: `Model ${index}.ifc` }; return [model.id, model];
  })) });
  const evidence = captureEvidence('loadReport');
  const ui = render(<EvidenceView evidence={evidence} state="captured" />);
  assert.match(ui.textContent ?? '', /100 of 120 metadata entries/);
  assert.match(ui.textContent ?? '', /Some model metadata was omitted or shortened/);
  assert.match(ui.textContent ?? '', /This snapshot is a sample. Unseen rows are not evaluated/);
  assert.match(ui.textContent ?? '', /does not establish which models an analysis evaluated/);
  assert.equal(ui.querySelectorAll('li').length, 100);
});

test('stale empty source and older portable envelopes never acquire current scope', () => {
  const evidence = captureEvidence('clash');
  const ui = render(<EvidenceView evidence={{ ...evidence, payload: '{}' }} state="stale" />);
  assert.match(ui.textContent ?? '', /Stale workspace evidence/);
  assert.match(ui.textContent ?? '', /Frozen evidence: 0 of 0/);
  assert.match(ui.textContent ?? '', /Model metadata is unavailable/);
  assert.doesNotMatch(ui.textContent ?? '', /0 of 0 metadata entries/);
});
