/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9668: the axis-drift check on real files. An Axis export whose members sit
// on their beams and columns reports no drift; a model derived here, with its
// ends moved and members split at joints, reports none either; a column
// moved sideways is reported by exactly its distance.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, extractStructuralOnDemand, structuralConsistencyIssues, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { applyStructuralDerivation, planStructuralDerivation, readStructuralDerivationFacts, structuralPhysicalAxes, transformElementsInStore } from '../index.js';

const fixture = (path: string) => new URL(`../../../../tests/models/${path}`, import.meta.url);
const STEEL_FRAME = 'structural/ifc_structuralanalysisview/little_steel_frame-3D--Axis-Struc.ifc';
const STR = 'various/02_BIMcollab_Example_STR_random_C_ebkp.ifc';

const parse = (bytes: Uint8Array) =>
  new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });

async function load(path: string) {
  const store = await parse(readFileSync(fixture(path)));
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  return { store, view, editor: new StoreEditor(store, view) };
}

const reparse = (store: IfcDataStore, view: MutablePropertyView) =>
  parse(new StepExporter(store, view).export({ schema: store.schemaVersion as 'IFC2X3' | 'IFC4', applyMutations: true }).content);

const drift = (store: IfcDataStore) =>
  structuralConsistencyIssues(store, { physicalAxes: structuralPhysicalAxes(store) }).filter((issue) => issue.rule === 'structural-axis-drift');

describe('structuralPhysicalAxes with the axis-drift check', () => {
  it.skipIf(!existsSync(fixture(STEEL_FRAME)))('reads an axis for every linked beam and column of an Axis export, with no drift', async () => {
    const { store } = await load(STEEL_FRAME);
    const axes = structuralPhysicalAxes(store);
    const linked = new Set(extractStructuralOnDemand(store).members.flatMap((m) => m.physicalElementIds ?? []));
    expect(linked.size).toBe(86);
    expect([...linked].filter((id) => !axes.has(id))).toEqual([]);
    expect(drift(store)).toEqual([]);
  });

  it.skipIf(!existsSync(fixture(STEEL_FRAME)))('reports the members of a column moved 0.25 m, and only those', async () => {
    const { store, view, editor } = await load(STEEL_FRAME);
    const column = 106;
    const members = extractStructuralOnDemand(store).members.filter((m) => m.physicalElementIds?.includes(column)).map((m) => m.expressId);
    expect(members.length).toBeGreaterThan(0);
    transformElementsInStore({ dataStore: store, view, editor, selected: [column], op: { kind: 'move', delta: [0, 0.25] } });
    const issues = drift(await reparse(store, view));
    expect(issues.map((issue) => [issue.entityId, issue.target])).toEqual(members.map((id) => [id, column]));
    for (const issue of issues) expect(issue.distance).toBeCloseTo(0.25, 6);
  });

  it.skipIf(!existsSync(fixture(STR)))('reports no drift on a model derived from the physical one', async () => {
    const { store, view, editor } = await load(STR);
    const plan = planStructuralDerivation(readStructuralDerivationFacts(store, editor));
    expect(plan.report.extendedEnds.length).toBeGreaterThan(0);
    applyStructuralDerivation(editor, store, plan);
    const derived = await reparse(store, view);
    expect(extractStructuralOnDemand(derived).members.length).toBe(plan.curveMembers.length + plan.surfaceMembers.length);
    expect(drift(derived)).toEqual([]);
  });
});
