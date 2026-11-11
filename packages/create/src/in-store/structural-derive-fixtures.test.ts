/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9668: the structural derivation on real exports. Two physical models, and
// two AxisVM files that carry both a physical and an authored analytical model,
// where the derived members are measured against the authored ones.
// Set STRUCTURAL_DERIVE_OUT=<dir> to keep the written file (ifcopenshell validation).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, extractStructuralOnDemand, structuralCounterparts, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { applyStructuralDerivation, planStructuralDerivation, readStructuralDerivationFacts } from '../index.js';
import { liveStructuralExtraction } from './structural-derive-facts.js';
import { createStyleEntityReader } from './style-entity-reader.js';
import { applyFrame, axis3d, composeFrame, placementInAncestor, pointOf, refId, type Frame3 } from './host-geometry-frame.js';
import { safeLengthUnitScale } from './length-unit-scale.js';
import type { Vec3 } from './structural-derive-types.js';

const fixture = (path: string) => new URL(`../../../../tests/models/${path}`, import.meta.url);
const STR = 'various/02_BIMcollab_Example_STR_random_C_ebkp.ifc';
const TESSELLATED = 'buildingsmart/Building-Structural.ifc';
const STEEL_FRAME = 'structural/ifc_structuralanalysisview/little_steel_frame-3D--Axis-Struc.ifc';
const BASEMENT = 'structural/ifc_structuralanalysisview/house_basement_floor--Axis-Struc.ifc';
const missing = [STR, TESSELLATED, STEEL_FRAME, BASEMENT].filter((p) => !existsSync(fixture(p)));
if (missing.length) console.warn(`skip: structural derivation fixtures missing (${missing.join(', ')}); run \`pnpm fixtures\``);
const has = (path: string) => !missing.includes(path);

async function load(path: string) {
  const bytes = readFileSync(fixture(path));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  return { store, editor: new StoreEditor(store, view) };
}
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const WORLD: Frame3 = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Read an authored item's placement frame and first topology item, in world metres. */
function authoredReader(store: IfcDataStore, editor: StoreEditor) {
  const read = createStyleEntityReader(store, editor);
  const reader = { entity: read };
  const metres = safeLengthUnitScale(store.source, store.entityIndex, 'test') ?? 1;
  const frameOf = (id: number) => {
    const placement = refId(read(id)!.attributes[5]);
    return placement === null ? WORLD : placementInAncestor(reader, placement, null)!;
  };
  const topology = (id: number) => {
    const shape = read(refId(read(id)!.attributes[6])!)!;
    const rep = read(refId((shape.attributes[2] as unknown[])[0])!)!;
    return read(refId((rep.attributes[3] as unknown[])[0])!)!;
  };
  return {
    read,
    /** IfcEdge end points of a curve member. */
    edge(id: number): Vec3[] {
      const edge = topology(id);
      return [edge.attributes[0], edge.attributes[1]].map((vertex) =>
        applyFrame(frameOf(id), pointOf(reader, read(refId(vertex)!)!.attributes[0])!).map((v) => v * metres) as Vec3);
    },
    /** The IfcPlane under a surface member's face: a point (metres) and its normal. */
    plane(id: number): { o: Vec3; n: Vec3 } {
      let surface = read(refId(topology(id).attributes[1])!)!;
      if (surface.type.toUpperCase() === 'IFCCURVEBOUNDEDPLANE') surface = read(refId(surface.attributes[0])!)!;
      const frame = composeFrame(frameOf(id), axis3d(reader, surface.attributes[0])!);
      return { o: frame.o.map((v) => v * metres) as Vec3, n: frame.z };
    },
  };
}

/** Derive while ignoring the authored model, so the derived one can be compared with it. */
async function deriveBesideAuthored(path: string) {
  const { store, editor } = await load(path);
  const facts = readStructuralDerivationFacts(store, editor);
  expect(facts.elements.every((e) => e.bounds !== undefined || e.idealised)).toBe(true);
  const plan = planStructuralDerivation({ ...facts, elements: facts.elements.map((e) => ({ ...e, idealised: false })) });
  return { store, editor, plan, authored: liveStructuralExtraction(store, editor.getMutationView()) };
}

describe('structural derivation on real physical models (#9668)', () => {
  it.skipIf(!has(STR))('derives a millimetre IFC2X3 frame with footings, and every written item links back', async () => {
    const { store, editor } = await load(STR);
    const plan = planStructuralDerivation(readStructuralDerivationFacts(store, editor));
    expect(plan.report.counts).toMatchObject({ curveMembers: 106, surfaceMembers: 118, supports: 26, guessedSupports: 0, assumedLoadBearing: 0 });
    const reasons = plan.report.skipped.map((s) => `${s.type}:${s.reason}`);
    expect(reasons.filter((r) => r === 'IfcFooting:footing-without-member-end')).toHaveLength(9);
    expect(reasons.filter((r) => !r.startsWith('IfcFooting'))).toEqual(['IfcWallStandardCase:no-idealisable-shape']);

    applyStructuralDerivation(editor, store, plan);
    const { content } = new StepExporter(store, editor.getMutationView()).export({ schema: 'IFC2X3', applyMutations: true });
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    const out = process.env.STRUCTURAL_DERIVE_OUT;
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'derived-bimcollab-str.ifc'), text); }
    const data = extractStructuralOnDemand(await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true }));
    expect(data.members).toHaveLength(224);
    expect(data.connections).toHaveLength(plan.nodes.length);
    expect(data.analysisModels[0].itemGlobalIds).toHaveLength(224 + plan.nodes.length);
    const unlinked = [...data.members, ...data.connections].filter((item) => structuralCounterparts(data, item.expressId)?.side !== 'physical');
    expect(unlinked).toEqual([]);
  });

  it.skipIf(!has(TESSELLATED))('skips every tessellated element with the reason, and writes nothing', async () => {
    const { store, editor } = await load(TESSELLATED);
    const plan = planStructuralDerivation(readStructuralDerivationFacts(store, editor));
    expect(plan.report.counts.curveMembers + plan.report.counts.surfaceMembers).toBe(0);
    const [footings, others] = [plan.report.skipped.filter((s) => s.type === 'IfcFooting'), plan.report.skipped.filter((s) => s.type !== 'IfcFooting')];
    expect(others).toHaveLength(10);
    expect(others.every((s) => s.reason === 'no-idealisable-shape' && /TRIANGULATEDFACESET/.test(s.detail))).toBe(true);
    // A footing needs only its body bounds, which a tessellation has.
    expect(footings.map((s) => s.reason)).toEqual(['footing-without-member-end']);
    expect(() => applyStructuralDerivation(editor, store, plan)).toThrow(/no members/);
  });
});

describe('derived against authored analytical models (#9668)', () => {
  it.skipIf(!has(STEEL_FRAME))('steel frame: every beam and column matches its authored member within 0.05 m', async () => {
    const { store, editor, plan, authored } = await deriveBesideAuthored(STEEL_FRAME);
    const geometry = authoredReader(store, editor);
    expect(plan.curveMembers).toHaveLength(86);
    const errors = plan.curveMembers.map((member) => {
      const counterparts = structuralCounterparts(authored, member.elementId)!.expressIds
        .filter((id) => geometry.read(id)?.type.toUpperCase() === 'IFCSTRUCTURALCURVEMEMBER');
      // Authored members split at intermediate nodes: compare with the nearest authored end.
      const ends = counterparts.flatMap((id) => geometry.edge(id));
      return Math.max(...[member.start, member.end].map((p) => Math.min(...ends.map((q) => distance(p, q)))));
    });
    expect(Math.max(...errors)).toBeLessThan(0.05);
  });

  it.skipIf(!has(BASEMENT))('basement: every slab and wall lies on its authored plane with the authored thickness', async () => {
    const { store, editor, plan, authored } = await deriveBesideAuthored(BASEMENT);
    const geometry = authoredReader(store, editor);
    expect(plan.surfaceMembers).toHaveLength(10);
    for (const member of plan.surfaceMembers) {
      const [id] = structuralCounterparts(authored, member.elementId)!.expressIds;
      const info = authored.members.find((m) => m.expressId === id) as { thickness?: number };
      expect(member.thickness).toBeCloseTo(info.thickness!, 3);
      const { o, n } = geometry.plane(id);
      const centre = member.boundary.reduce<Vec3>((c, p) => [c[0] + p[0], c[1] + p[1], c[2] + p[2]], [0, 0, 0]).map((v) => v / member.boundary.length) as Vec3;
      expect(Math.abs((centre[0] - o[0]) * n[0] + (centre[1] - o[1]) * n[1] + (centre[2] - o[2]) * n[2])).toBeLessThan(0.001);
    }
  });
});
