/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cost evidence (#6833): IfcCostItem rows evaluated by the same `bim.cost`
 * backend as the Cost panel, over the committed sample with a real cost
 * schedule appended and parsed by the real parser. Totals are per currency
 * and never mix "no cost source", "no cost data" and "no amount".
 */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { render, click, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useViewerStore, type FederatedModel } from '@/store';
import { addDecimalStrings, isDecimalAmount } from '@/lib/cost/decimal-sum';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { cancelAssistant, useAssistant } from '../conversation';

const SAMPLE = new URL('../../../../public/samples/building-architecture.ifc', import.meta.url);
const FILE_END = /ENDSEC;\r?\nEND-ISO-10303-21;/;
const initial = useViewerStore.getState();
const initialAssistant = useAssistant.getState();
afterEach(() => { cleanup(); cancelAssistant(); useAssistant.setState(initialAssistant, true); useViewerStore.setState(initial, true); });

/** A CHF budget: two root items, one nested child, one EUR item, one item without values. */
const BUDGET = [
  "#90001=IFCMONETARYUNIT('CHF');",
  "#90002=IFCMONETARYUNIT('EUR');",
  '#90010=IFCMEASUREWITHUNIT(IFCMONETARYMEASURE(7.25),#90002);',
  "#90020=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(100.1),$,$,$,$,$,$,$);",
  "#90021=IFCCOSTVALUE('Small',$,IFCMONETARYMEASURE(0.2),$,$,$,$,$,$,$);",
  "#90022=IFCCOSTVALUE('Euro',$,#90010,$,$,$,$,$,$,$);",
  "#90030=IFCCOSTITEM('0CostRootA000000000001',$,'Walls',$,$,'C-1',.USERDEFINED.,(#90020),$);",
  "#90031=IFCCOSTITEM('0CostRootB000000000002',$,'Fixings',$,$,'C-2',.USERDEFINED.,(#90021),$);",
  "#90032=IFCCOSTITEM('0CostChild000000000003',$,'Wall labour',$,$,'C-1.1',.USERDEFINED.,(#90020),$);",
  "#90033=IFCCOSTITEM('0CostEuro0000000000004',$,'Imported',$,$,'C-3',.USERDEFINED.,(#90022),$);",
  "#90034=IFCCOSTITEM('0CostEmpty000000000005',$,'Unpriced',$,$,'C-4',.USERDEFINED.,$,$);",
  "#90040=IFCCOSTSCHEDULE('0CostSchedule000000006',$,'Budget',$,$,'S-1',.BUDGET.,'DRAFT',$,$);",
  "#90041=IFCRELASSIGNSTOCONTROL('0CostAssign00000000007',$,$,$,(#90030,#90031,#90033,#90034),$,#90040);",
  "#90042=IFCRELNESTS('0CostNest0000000000008',$,$,$,#90030,(#90032));",
];

async function parse(extra: string[] | null): Promise<IfcDataStore> {
  let text = await readFile(SAMPLE, 'utf8');
  if (extra) {
    assert.match(text, FILE_END);
    text = text.replace('#14=IFCUNITASSIGNMENT((#15,#16,#17));', '#14=IFCUNITASSIGNMENT((#15,#16,#17,#90001));')
      .replace(FILE_END, `${extra.join('\n')}\nENDSEC;\nEND-ISO-10303-21;`);
  }
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
}

const model = (id: string, store: IfcDataStore, idOffset = 0): FederatedModel =>
  ({ ...fixtureModel(id, { idOffset }), name: `${id}.ifc`, ifcDataStore: store, maxExpressId: 100_000 });

interface CostRow { modelId: string; globalId: string; GlobalId: string; Identification: string; Amount: string | null; Currency: string | null; status: string; rootItem: boolean; diagnostics: Array<{ code: string }> }
interface Total { currency: string | null; rootTotal: string | null; rootItemsWithAmount: number; itemsWithAmount: number }

test('#6833 cost: exact decimal totals are not binary floats', () => {
  assert.equal(addDecimalStrings('100.1', '0.2'), '100.3');
  assert.equal(addDecimalStrings('-600', '1e3'), '400');
  assert.equal(addDecimalStrings('0.1', '-0.15'), '-0.05');
  // Evaluator outputs with no exact sum are recognised up front, so the adapter withholds a total instead of throwing.
  for (const amount of ['NaN', 'Infinity', '-Infinity', '', '1e100000']) assert.equal(isDecimalAmount(amount), false, amount);
  for (const amount of ['0', '-12.50', '1e3', '.5']) assert.equal(isDecimalAmount(amount), true, amount);
});

test('#6833 cost: no IFC source is unavailable, never an empty cost model', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('glb')));
  const snapshot = captureEvidence('cost');
  assert.equal(JSON.parse(snapshot.payload).sourceAvailability, 'unavailable');
  assert.equal(snapshot.totalRows, 0);
});

test('#6833 cost: the Cost panel action cites items, per-currency root totals and each model state', async () => {
  const costed = await parse(BUDGET);
  const plain = await parse(null);
  useViewerStore.setState(fixtureModels(model('budget', costed), model('plain', plain, 1_000_000), fixtureModel('glb', { idOffset: 2_000_000 })));
  const ui = render(renderPanelBody('cost', () => undefined));
  const button = ui.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(button, 'the Cost header offers Discuss with AI');
  click(button);
  const snapshot = useAssistant.getState().snapshot;
  assert.equal(snapshot?.source, 'cost');
  assert.ok(snapshot);
  const payload = JSON.parse(snapshot.payload);
  assert.equal(payload.sourceAvailability, 'available');
  assert.equal(snapshot.totalRows, 5);

  const [budget, plainModel, glb] = payload.evidence.summary.models;
  assert.equal(budget.status, 'cost-data');
  assert.equal(budget.costScheduleCount, 1);
  assert.equal(budget.costItemCount, 5);
  assert.equal(budget.rootItemCount, 4, 'the nested child is not a root');
  assert.equal(budget.itemsWithoutAmount, 1);
  assert.equal(plainModel.status, 'no-cost-data', 'a read source without cost data is not "no source"');
  assert.equal(glb.status, 'no-cost-source');

  const totals = budget.totals as Total[];
  const chf = totals.find(total => total.currency === 'CHF');
  const eur = totals.find(total => total.currency === 'EUR');
  assert.deepEqual(chf && { rootTotal: chf.rootTotal, roots: chf.rootItemsWithAmount, all: chf.itemsWithAmount }, { rootTotal: '100.3', roots: 2, all: 3 },
    'the nested child is counted but not added on top of its root');
  assert.deepEqual(eur && { rootTotal: eur.rootTotal, roots: eur.rootItemsWithAmount }, { rootTotal: '7.25', roots: 1 }, 'euros are never added to francs');

  const rows = payload.evidence.rows.map((row: { data: CostRow }) => row.data) as CostRow[];
  const walls = rows.find(row => row.Identification === 'C-1');
  assert.ok(walls);
  assert.equal(walls.modelId, 'budget');
  assert.equal(walls.globalId, '0CostRootA000000000001');
  assert.equal(walls.Amount, '100.1');
  assert.equal(walls.Currency, 'CHF');
  assert.equal(walls.rootItem, true);
  assert.equal(rows.find(row => row.Identification === 'C-1.1')?.rootItem, false);
  const unpriced = rows.find(row => row.Identification === 'C-4');
  assert.equal(unpriced?.Amount, null);
  assert.equal(unpriced?.status, 'no-amount');
  assert.ok(unpriced?.diagnostics.some(diagnostic => diagnostic.code === 'MISSING_VALUE'), 'the native reason travels with the row');

  assert.equal(evidenceIsCurrent(snapshot), true);
  cleanup();
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(snapshot), false, 'an edit makes cost evidence stale');
});

test('#6833 cost: large schedules report the exact native item count over a bounded sample; a new federation is not current', async () => {
  const items = Array.from({ length: 130 }, (_, i) => `#${91000 + i}=IFCCOSTITEM('0CostBulk${String(i).padStart(13, '0')}',$,'Bulk ${i}',$,$,'B-${i}',.USERDEFINED.,(#90021),$);`);
  useViewerStore.setState(fixtureModels(model('bulk', await parse([...BUDGET, ...items]))));
  const snapshot = captureEvidence('cost');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(snapshot.totalRows, 135);
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.sampled, true);
  assert.equal(payload.evidence.summary.models[0].costItemCount, 135);
  const chf = (payload.evidence.summary.models[0].totals as Total[]).find(total => total.currency === 'CHF');
  assert.equal(chf?.rootTotal, '126.3', '100.1 + 0.2 + 130 x 0.2, exactly');
  assert.ok(snapshot.payload.length <= 48_000);
  useViewerStore.setState(fixtureModels(model('other', await parse(null))));
  assert.equal(evidenceIsCurrent(snapshot), false);
});
