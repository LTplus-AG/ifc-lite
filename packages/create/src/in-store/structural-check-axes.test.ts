/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9668: the axis-drift check on real files. The physical axes are pinned to
// ifcopenshell's; an Axis export whose members sit on their beams and columns
// reports no drift; a column moved sideways is reported by exactly its
// distance. A model derived here reports no drift either: that proves the
// joints (ends moved, members split) stay on the axis, not that the axis is
// right, since the derivation starts from the same line. The pin, on both
// files, is what checks the line itself.
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

/**
 * Centre lines of one element per section type in each fixture, from
 * IfcOpenShell 0.9.0 and not from this package
 * (`tools/ifcopenshell_reference/structural_axes.py`, which states the method
 * and the command), rounded to 0.1 mm. STR is the file the derived-model test
 * below derives from, so its start lines are pinned too. Of the 192 curve
 * elements in the two files, all agree within 1 mm except the eight
 * L 75x75x6 braces of the steel frame: the derivation idealises an angle
 * through its profile bounds, 25 mm off its centroid line (#9934).
 */
const IFCOPENSHELL_AXES: ReadonlyArray<[file: string, id: number, section: string, a: Vec3, b: Vec3]> = [
  [STEEL_FRAME, 88, 'IfcBeam HE 140 A, sloped', [1.5, 0, 5], [0, 0, 6]],
  [STEEL_FRAME, 284, 'IfcBeam HE 240 B', [1.5, 0, 5], [10.5, 0, 5]],
  [STEEL_FRAME, 880, 'IfcBeam HE 140 B', [12, 0, 6], [12, 7.4, 6]],
  [STEEL_FRAME, 1028, 'IfcBeam 100x160', [0, 0, 6.2], [0, 7.4, 6.2]],
  [STEEL_FRAME, 106, 'IfcColumn HE 180 B', [1.5, 0, 5], [1.5, 0, 6]],
  [STEEL_FRAME, 814, 'IfcColumn HE 300 B', [12, 0, 0], [12, 0, 6]],
  [STR, 489, 'IfcBeam rafter 71 x 171', [31.0542, 18.9696, 10.4145], [33.5305, 18.9696, 10.4145]],
  [STR, 500, 'IfcBeam IPE180', [25.875, 12, 10.352], [29.155, 12, 10.352]],
  [STR, 535, 'IfcBeam HEA180', [25.875, 3.7964, 8.105], [25.875, 9, 8.105]],
  [STR, 548, 'IfcBeam concrete 400 x 500', [33.3805, 14.16, -1.05], [40.935, 14.16, -1.05]],
  [STR, 261, 'IfcColumn concrete 300 x 300', [31.105, 12, 10.5], [31.105, 12, 12]],
  [STR, 273, 'IfcColumn concrete D300', [21.3752, 8.3573, -0.85], [21.3752, 8.3573, 3.27]],
];
type Vec3 = readonly [number, number, number];
const apart = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
/** Rounding to 0.1 mm moves an endpoint at most 0.09 mm; a misplaced line is off by far more. */
const PIN_TOLERANCE = 1e-3;

const skipWithout = (ctx: { skip(note: string): void }, file: string) => {
  if (!existsSync(fixture(file))) ctx.skip(`${file} missing; run \`pnpm fixtures\``);
};

describe('structuralPhysicalAxes with the axis-drift check', () => {
  for (const file of [STEEL_FRAME, STR]) {
    it(`puts each axis where IfcOpenShell puts the element's centre line: ${file.split('/').pop()} (#9930 review)`, async (ctx) => {
      skipWithout(ctx, file);
      const axes = structuralPhysicalAxes(await parse(readFileSync(fixture(file))));
      for (const [, id, section, a, b] of IFCOPENSHELL_AXES.filter(([f]) => f === file)) {
        const axis = axes.get(id);
        expect(axis, `#${id} ${section}`).toBeDefined();
        const [p, q] = axis!;
        // Either direction: the oracle does not order the ends.
        const error = Math.min(Math.max(apart(p, a), apart(q, b)), Math.max(apart(p, b), apart(q, a)));
        expect(error, `#${id} ${section}: ${JSON.stringify(axis)}`).toBeLessThan(PIN_TOLERANCE);
      }
    }, 30_000);
  }

  it('reads an axis for every linked beam and column of an Axis export, with no drift', async (ctx) => {
    skipWithout(ctx, STEEL_FRAME);
    const { store } = await load(STEEL_FRAME);
    const axes = structuralPhysicalAxes(store);
    const linked = new Set(extractStructuralOnDemand(store).members.flatMap((m) => m.physicalElementIds ?? []));
    expect(linked.size).toBe(86);
    expect([...linked].filter((id) => !axes.has(id))).toEqual([]);
    expect(drift(store)).toEqual([]);
  }, 30_000);

  it('reports the members of a column moved 0.25 m, and only those', async (ctx) => {
    skipWithout(ctx, STEEL_FRAME);
    const { store, view, editor } = await load(STEEL_FRAME);
    const column = 106;
    const members = extractStructuralOnDemand(store).members.filter((m) => m.physicalElementIds?.includes(column)).map((m) => m.expressId);
    expect(members.length).toBeGreaterThan(0);
    transformElementsInStore({ dataStore: store, view, editor, selected: [column], op: { kind: 'move', delta: [0, 0.25] } });
    const issues = drift(await reparse(store, view));
    expect(issues.map((issue) => [issue.entityId, issue.target])).toEqual(members.map((id) => [id, column]));
    for (const issue of issues) expect(issue.distance).toBeCloseTo(0.25, 6);
  }, 30_000);

  it('reports no drift on a model derived from the physical one', async (ctx) => {
    skipWithout(ctx, STR);
    const { store, view, editor } = await load(STR);
    const plan = planStructuralDerivation(readStructuralDerivationFacts(store, editor));
    expect(plan.report.extendedEnds.length).toBeGreaterThan(0);
    applyStructuralDerivation(editor, store, plan);
    const derived = await reparse(store, view);
    expect(extractStructuralOnDemand(derived).members.length).toBe(plan.curveMembers.length + plan.surfaceMembers.length);
    expect(drift(derived)).toEqual([]);
  }, 60_000);
});
