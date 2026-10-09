/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { readCurrentTypeQuantities, extractTypeQuantitiesOnDemand } from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { render, cleanup } from '@/test/render';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { inheritedSource, parse, net } from '@/test/inherited-quantities-native-fixture';
const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });
for (const skipHistory of [true, false]) test(`#7355 current Type quantity reader/card matches native export for exact skipHistory=${skipHistory} write`, async t => {
  const f = await inheritedSource(t); if (!f) return;
  const { store, b, relation, view } = f;
  view.setPositionalAttribute(relation, 5, `#${b.type}`);
  const before = editedModelBytes(store, view);
  assert.equal(net(extractTypeQuantitiesOnDemand(await parse(before), f.f.id)?.quantities ?? []), 30);
  const historyBefore = view.getMutations().length;
  view.setQuantity(b.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume, undefined, skipHistory);
  const historyDelta = view.getMutations().length - historyBefore;
  const overlay = net(view.getQuantitiesForEntity(b.type));
  const currentBefore = readCurrentTypeQuantities(store, f.f.id, view);
  useViewerStore.setState({ propertiesActiveTab: 'quantities', unitDisplayOverrides: {} });
  const liveBefore = render(<PropertiesPanel />).textContent; cleanup();
  const bytes = editedModelBytes(store, view), saved = await parse(bytes);
  const native = net(extractTypeQuantitiesOnDemand(saved, f.f.id)?.quantities ?? []);
  const currentAfter = readCurrentTypeQuantities(store, f.f.id, view);
  const liveAfter = render(<PropertiesPanel />).textContent; cleanup();
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: saved }]]), ifcDataStore: saved,
    mutationViews: new Map(), storeEditors: new Map() });
  const savedCard = render(<PropertiesPanel />).textContent; cleanup();
  console.log('WRITER_CURRENT_CARD_MATRIX', JSON.stringify({ skipHistory, historyDelta, overlay,
    currentBefore, liveBefore, native, currentAfter, liveAfter, savedCard }));
  if (process.env.CAMPAIGN_WRITER_MATRIX_PREFIX) {
    await writeFile(`${process.env.CAMPAIGN_WRITER_MATRIX_PREFIX}-${skipHistory}.before.ifc`, before);
    await writeFile(`${process.env.CAMPAIGN_WRITER_MATRIX_PREFIX}-${skipHistory}.ifc`, bytes);
  }
  assert.equal(historyDelta, skipHistory ? 0 : 1);
  assert.equal(overlay, 35, 'exact real overlay contains the requested value');
  assert.equal(currentBefore.status, 'available');
  assert.equal(currentAfter.status, 'available');
  assert.equal(native, skipHistory ? 30 : 35, 'independent reparse distinguishes unchanged skipHistory nomination from supported default-history writer');
  assert.match(savedCard ?? '', new RegExp(`netNetVolume${native} m³`));
  if (!skipHistory) {
    assert.equal(net(currentBefore.value?.quantities ?? []), native, 'live current canonical reader must match independently exported supported Type write');
    assert.match(liveBefore ?? '', /netNetVolume35 m³/, 'mounted live card agrees before export');
    assert.equal(net(currentAfter.value?.quantities ?? []), native, 'export does not substitute for live canonical reading');
    assert.match(liveAfter ?? '', /netNetVolume35 m³/);
  }
});
