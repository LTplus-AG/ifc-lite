/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Comparison impact (#6921) over the committed revision pair, every input a
 * native run: the A/B diff, one clash run over both revisions, the committed
 * IDS (plus one declared furniture requirement) on each revision, a wall
 * quantity list on B, and BCF topics naming real GlobalIds.
 *
 * Invariants: an analysis joins a change only on (model, GlobalId); an
 * unchanged element and a reused GlobalId in a model outside the comparison
 * are never joined; one modified element is one change; numbers are copied
 * from the native results; a stale analysis is disclosed, not hidden.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addViewpointToTopic, createBCFTopic, type BCFTopic } from '@ifc-lite/bcf';
import { executeList, type ListDefinition } from '@ifc-lite/lists';
import { IfcTypeEnum } from '@ifc-lite/data';
import { createListDataProvider } from '@/lib/lists/adapter';
import type { ViewerState } from '@/store';
import { stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { compareImpactOf } from './compare-analysis-state';
import { computeCompareImpact, type ImpactInput, type ImpactRow } from './impact';
import { PINS, revisionPair, runClash, runIds, type RevisionPair } from './revision-pair.test-support';

/** A requirement every IfcFurniture fails, so the deleted furniture has a validation finding on A. */
const FURNITURE_SPEC = `<specification name="Furniture is described" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IFCFURNITURE</simpleValue></name></entity></applicability>
      <requirements><attribute><name><simpleValue>Description</simpleValue></name><value><simpleValue>never-authored-6921</simpleValue></value></attribute></requirements>
    </specification>
  </specifications>`;
const withFurnitureSpec = (xml: string) => xml.replace(/<\/specifications>/, FURNITURE_SPEC);

const globalIdOf = (pair: RevisionPair) => (modelId: string, localId: number) =>
  (modelId === 'A' ? pair.base : modelId === 'B' ? pair.head : undefined)?.ifcDataStore.entities.getGlobalId(localId) || undefined;

function topic(title: string, guids: string[]): BCFTopic {
  const t = createBCFTopic({ title, author: 'coordinator@example.com' });
  addViewpointToTopic(t, { guid: `vp-${title}`, components: { selection: guids.map(ifcGuid => ({ ifcGuid })) } });
  return t;
}

function wallVolumeList(pair: RevisionPair) {
  const definition: ListDefinition = { id: 'walls', name: 'Wall volumes', createdAt: 0, updatedAt: 0,
    entityTypes: [IfcTypeEnum.IfcWall], groups: [],
    columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' },
      { id: 'vol', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetVolume' }] };
  return executeList(definition, createListDataProvider(pair.head.ifcDataStore, 'B'), 'B');
}

async function input(pair: RevisionPair, extra: Partial<ImpactInput> = {}): Promise<ImpactInput> {
  return { baseModelId: 'A', headModelId: 'B', entries: pair.compare.diff.entries, globalIdOf: globalIdOf(pair),
    clash: { result: await runClash(pair, ['A', 'B']), stale: false },
    validation: { report: await runIds(pair, 'A', { edit: withFurnitureSpec }), stale: false }, ...extra };
}

const rowsOf = <K extends ImpactRow['kind']>(rows: ImpactRow[], kind: K) =>
  rows.filter((row): row is Extract<ImpactRow, { kind: K }> => row.kind === kind);

describe('comparison impact on the committed revision pair (#6921)', () => {
  it('joins the injected duct clash, the deleted furniture finding, the wall quantities and a topic — and nothing unchanged', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const list = wallVolumeList(pair);
    const topics = [topic('Deleted chair', [PINS.deleted]), topic('Unchanged wall', [PINS.clashHit])];
    const impact = computeCompareImpact(await input(pair, { list: { id: 'walls', name: 'Wall volumes', result: list, stale: false }, bcfTopics: topics }));

    // Four native changes: one added, one deleted, two modified — each counted once.
    assert.deepEqual(pair.compare.diff.counts, { added: 1, deleted: 1, modified: 2, unchanged: 19 });
    assert.equal(impact.changedElements, 4);
    assert.equal(impact.unresolvedChanges, 0);
    assert.deepEqual(impact.sources, { clash: 'available', validation: 'available', list: 'available', bcf: 'available' });

    // Clash: both duct clashes (inside B, and B's duct against A's wall) touch
    // the added duct; the wall they hit is unchanged and is never named as changed.
    const clashes = rowsOf(impact.rows, 'clash');
    assert.equal(clashes.length, 2);
    for (const row of clashes) {
      assert.deepEqual(row.changed.map(c => [c.globalId, c.side, c.state]), [[PINS.clashAdded, 'head', 'added']]);
      assert.ok(row.elements.some(e => e.globalId === PINS.clashHit));
      assert.equal(row.status, 'hard');
    }

    // Validation on A: the deleted furniture's failure is joined (base side);
    // the committed IDS's other failures name unchanged elements.
    const validation = rowsOf(impact.rows, 'validation');
    assert.deepEqual(validation.map(r => [r.specificationName, r.changed.globalId, r.side, r.changed.state]),
      [['Furniture is described', PINS.deleted, 'base', 'deleted']]);
    assert.ok(validation[0].failedRequirements.length > 0);

    // List: the two modified walls, with native NetVolume sums.
    const [listRow] = rowsOf(impact.rows, 'list');
    assert.equal(listRow.touchedRows, 2);
    assert.equal(listRow.totalRows, list.rows.length);
    assert.deepEqual(listRow.changed.map(c => c.globalId).sort(), [PINS.dataModified, PINS.geometryMoved].sort());
    const volumeIndex = list.columns.findIndex(c => c.id === 'vol');
    const volumeOf = (globalId: string) => list.rows.filter(row => pair.head.ifcDataStore.entities.getGlobalId(row.entityId) === globalId)
      .reduce((sum, row) => sum + (row.values[volumeIndex] as number), 0);
    const volume = listRow.columns.find(c => c.label === 'NetVolume');
    assert.ok(volume, 'the numeric quantity column is reported');
    assert.ok(Math.abs(volume.touchedSum - (volumeOf(PINS.dataModified) + volumeOf(PINS.geometryMoved))) < 1e-9);
    assert.ok(volume.touchedSum > 0 && volume.touchedSum < volume.totalSum);
    assert.equal(impact.totals.list, 2);

    // BCF: only the topic naming the deleted element.
    assert.deepEqual(rowsOf(impact.rows, 'bcf').map(r => [r.title, r.changed.map(c => c.state)]), [['Deleted chair', ['deleted']]]);
    assert.deepEqual(impact.totals, { clash: 2, validation: 1, list: 2, bcf: 1 });
  });

  it('never joins a reused GlobalId in a model outside the comparison', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    // The same validation report, attributed to a third loaded copy of A.
    const report = await runIds(pair, 'A', { edit: withFurnitureSpec });
    const copy = { ...report, specificationResults: report.specificationResults.map(spec => ({ ...spec,
      entityResults: spec.entityResults.map(entity => ({ ...entity, modelId: 'A-copy' })) })) };
    // The same findings joined while attributed to A, so the refusal below is not vacuous.
    assert.equal(computeCompareImpact(await input(pair, { validation: { report, stale: false } })).totals.validation, 1);
    const impact = computeCompareImpact(await input(pair, { validation: { report: copy, stale: false } }));
    assert.equal(rowsOf(impact.rows, 'validation').length, 0);
    assert.equal(impact.totals.validation, 0);
  });

  it('discloses stale and missing analyses and bounds rows without changing totals', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const base = await input(pair);
    const impact = computeCompareImpact({ ...base, clash: { ...base.clash!, stale: true }, validation: null, rowLimit: 1 });
    assert.deepEqual(impact.sources, { clash: 'stale', validation: 'unavailable', list: 'unavailable', bcf: 'unavailable' });
    assert.equal(impact.rows.length, 1);
    assert.equal(impact.totalRows, 2);
    assert.equal(impact.rowsTruncated, true);
    assert.equal(impact.totals.clash, 2);
  });

  it('discloses an analysis whose freshness is unknown as unverified, never as current', async (t) => {
    const pair = await revisionPair(t);
    if (!pair) return;
    const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), { mutationVersion: 1, geometryContentVersion: 0 });
    // A list result and an unstamped validation report carry no run stamp.
    const state = { compareResult: pair.compare, models: new Map([['A', pair.base], ['B', pair.head]]),
      clashResult: clash, clashRawResult: null, idsValidationReport: await runIds(pair, 'A'),
      listResult: wallVolumeList(pair), listDefinitions: [], activeListId: 'walls', bcfProject: null,
      mutationVersion: 1, geometryContentVersion: 0, modelPlacement: null } as unknown as ViewerState;
    assert.deepEqual(compareImpactOf(state)?.sources, { clash: 'available', validation: 'unverified', list: 'unverified', bcf: 'unavailable' });
    assert.equal(compareImpactOf({ ...state, mutationVersion: 2 })?.sources.clash, 'stale');
  });
});
