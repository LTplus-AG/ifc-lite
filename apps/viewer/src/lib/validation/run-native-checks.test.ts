/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '@ifc-lite/ids';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { Rule, type RuleSetFile } from '@ifc-lite/rules';
import { runIdsCheck } from './run-ids-check';
import { runInformationCheck } from './run-information-check';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#100=IFCWALL('0wall00000000000000000',$,'Wall A',$,$,$,$,$,.STANDARD.);
#101=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('NONE'),$);
#102=IFCPROPERTYSET('0pset00000000000000000',$,'Pset_WallCommon',$,(#101));
#103=IFCRELDEFINESBYPROPERTIES('0rel000000000000000000',$,$,$,(#100),#102);
ENDSEC;
END-ISO-10303-21;`;
const document = parseIDS(`<ids xmlns="http://standards.buildingsmart.org/IDS">
<info><title>Automation check</title></info><specifications>
<specification name="Walls are F90" ifcVersion="IFC4">
<applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
<requirements><property dataType="IFCLABEL"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
<baseName><simpleValue>FireRating</simpleValue></baseName><value><simpleValue>F90</simpleValue></value></property></requirements>
</specification></specifications></ids>`);
const models = new Map([['M', { name: 'walls.ifc', sourceFingerprint: 'source-identity' }]]);
const ruleSet: RuleSetFile = { version: 1, name: 'Fire rating', rules: [{
  id: 'fire-rating', name: 'Walls are F90',
  applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
  requirement: { kind: 'element', block: { groups: [{ rules: [Rule.property('Pset_WallCommon', 'FireRating', 'eq', 'F90')], combinator: 'AND' }], authoredAs: 'chips' } },
}] };
async function fixture() {
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer, { disableWorkerScan: true });
  const mutationView = new MutablePropertyView(null, 'M');
  mutationView.setExpressIdWatermark(103);
  return { dataStore, mutationView };
}
const originalWorker = globalThis.Worker;
afterEach(() => {
  if (originalWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
  else globalThis.Worker = originalWorker;
});

describe('shared native check execution (#6612)', () => {
  it('IDS evaluates effective corrections, deletions and creations, and snapshots remain independent', async () => {
    const { dataStore, mutationView } = await fixture();
    const input = { document, modelId: 'M', dataStore, mutationView, locale: 'en' as const, models };
    const before = await runIdsCheck(input);
    assert.equal(before.report.summary.totalEntitiesFailed, 1);
    mutationView.setProperty(100, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);
    const corrected = await runIdsCheck(input);
    assert.equal(corrected.report.summary.totalEntitiesPassed, 1);
    mutationView.deleteEntity(100);
    const created = mutationView.createEntity('IfcWall', ['0created00000000000000', null, 'Authored wall']);
    mutationView.setProperty(created.expressId, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String, undefined, false, 'IFCLABEL');
    const authored = await runIdsCheck(input);
    assert.equal(authored.report.summary.totalEntitiesChecked, 1);
    assert.equal(authored.report.summary.totalEntitiesPassed, 1);
    assert.equal(authored.report.specificationResults[0].entityResults[0].expressId, created.expressId);
    assert.equal(before.snapshot.summary.failed, 1);
    assert.equal(corrected.snapshot.summary.failed, 0);
    assert.equal(corrected.snapshot.reportModels?.[0].name, 'walls.ifc');
  });

  it('information checks honor explicit federation scope and overlay membership', async () => {
    const { dataStore, mutationView } = await fixture();
    mutationView.deleteEntity(100);
    const created = mutationView.createEntity('IfcWall', ['0created00000000000000', null, 'Authored wall']);
    mutationView.setProperty(created.expressId, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String, undefined, false, 'IFCLABEL');
    const outcome = await runInformationCheck({ ruleSet, models: [{ id: 'M', store: dataStore, mutationView }], reportModels: models });
    assert.equal(outcome.report.summary.totalEntitiesChecked, 1);
    assert.equal(outcome.report.summary.totalEntitiesPassed, 1);
    assert.deepEqual(outcome.report.modelInfo.map((model) => model.modelId), ['M']);
    assert.equal(outcome.snapshot.reportModels?.[0].name, 'walls.ifc');
  });

  it('information requirements see corrected values without mutating the parsed source store', async () => {
    const { dataStore, mutationView } = await fixture();
    const input = { ruleSet, models: [{ id: 'M', store: dataStore, mutationView }], reportModels: models };
    const before = await runInformationCheck(input);
    assert.equal(before.report.summary.totalEntitiesFailed, 1);
    mutationView.setProperty(100, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);
    const corrected = await runInformationCheck(input);
    assert.equal(corrected.report.summary.totalEntitiesPassed, 1);
    const sourceOnly = await runInformationCheck({ ...input, models: [{ id: 'M', store: dataStore }] });
    assert.equal(sourceOnly.report.summary.totalEntitiesFailed, 1, 'materialization must not rewrite the original store');
  });

  it('captures provenance before progress callbacks can rename the live model', async () => {
    const { dataStore } = await fixture();
    const model = { name: 'original.ifc', sourceFingerprint: 'original-source' };
    const outcome = await runIdsCheck({
      document, modelId: 'M', dataStore, locale: 'en', models: new Map([['M', model]]),
      onProgress: () => { model.name = 'replacement.ifc'; model.sourceFingerprint = 'replacement-source'; },
    });
    assert.equal(model.name, 'replacement.ifc', 'the live model must actually change');
    assert.equal(outcome.snapshot.reportModels?.[0].name, 'original.ifc');
  });

  it('aborting an active worker terminates it and never starts main-thread fallback', async () => {
    const { dataStore } = await fixture();
    const controller = new AbortController();
    let terminated = false;
    let progress = 0;
    class WaitingWorker {
      onmessage = null;
      onerror = null;
      onmessageerror = null;
      postMessage() { queueMicrotask(() => controller.abort()); }
      terminate() { terminated = true; }
    }
    (globalThis as { Worker?: unknown }).Worker = WaitingWorker;
    await assert.rejects(runIdsCheck({ document, modelId: 'M', dataStore, locale: 'en', models, signal: controller.signal, onProgress: () => progress++ }), { name: 'AbortError' });
    assert.equal(terminated, true);
    assert.equal(progress, 0, 'fallback evaluation would emit progress');
  });

  it('cancellation during non-abortable IDS execution prevents a completed result', async () => {
    const { dataStore } = await fixture();
    const controller = new AbortController();
    await assert.rejects(runIdsCheck({ document, modelId: 'M', dataStore, locale: 'en', models, signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  });

  it('already cancelled information work refuses execution without progress', async () => {
    const { dataStore } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runInformationCheck({ ruleSet, models: [{ id: 'M', store: dataStore }], reportModels: models, signal: controller.signal, onProgress: () => assert.fail('cancelled check emitted progress') }), { name: 'AbortError' });
  });
});
