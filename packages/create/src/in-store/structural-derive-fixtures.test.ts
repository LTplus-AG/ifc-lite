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
import { MutablePropertyView, StoreEditor, iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { applyStructuralDerivation, planStructuralDerivation, readStructuralDerivationFacts } from '../index.js';
import { liveStructuralExtraction } from './structural-derive-facts.js';
import { createStyleEntityReader } from './style-entity-reader.js';
import { applyFrame, axis3d, composeFrame, placementInAncestor, pointOf, refId, type Frame3 } from './host-geometry-frame.js';
import { safeLengthUnitScale } from './length-unit-scale.js';
import type { StructuralDerivationPlan, Vec3 } from './structural-derive-types.js';

const fixture = (path: string) => new URL(`../../../../tests/models/${path}`, import.meta.url);
const STR = 'various/02_BIMcollab_Example_STR_random_C_ebkp.ifc';
const TESSELLATED = 'buildingsmart/Building-Structural.ifc';
const STEEL_FRAME = 'structural/ifc_structuralanalysisview/little_steel_frame-3D--Axis-Struc.ifc';
const BASEMENT = 'structural/ifc_structuralanalysisview/house_basement_floor--Axis-Struc.ifc';
const ROOF_TRUSS = 'structural/ifc_structuralanalysisview/roof_truss--Axis-Struc.ifc';
const E1_3 = 'structural/ifc_structuralanalysisview/E1--3-Axis-Struc-Export.ifc';
/** Not in the fixture manifest (like the #584 geometry test): copy it in by hand to run its row. */
const AC20 = 'ara3d/AC-20-Smiley-West-10-Bldg.ifc';
const missing = [STR, TESSELLATED, STEEL_FRAME, BASEMENT, ROOF_TRUSS, E1_3].filter((p) => !existsSync(fixture(p)));
if (missing.length) console.warn(`skip: structural derivation fixtures missing (${missing.join(', ')}); run \`pnpm fixtures\``);
const has = (path: string) => !missing.includes(path) && existsSync(fixture(path));

async function load(path: string) {
  const bytes = readFileSync(fixture(path));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  return { store, editor: new StoreEditor(store, view) };
}
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Joints (nodes shared by two or more elements), free ends and the largest end move of a plan. */
function joints(plan: StructuralDerivationPlan) {
  return {
    joints: plan.nodes.filter((node) => new Set(node.elementIds).size >= 2).length,
    freeEnds: plan.report.freeEnds.length,
    extendedEnds: plan.report.extendedEnds.length,
    maxExtension: Math.max(0, ...plan.report.extendedEnds.map((e) => Math.abs(e.distance))),
  };
}
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
    // 106 elements; members met in their interior are split (#9668 review: joints).
    expect(plan.report.counts).toMatchObject({ curveMembers: 142, surfaceMembers: 118, supports: 26, guessedSupports: 0, assumedLoadBearing: 0 });
    expect(new Set(plan.curveMembers.map((m) => m.elementId)).size).toBe(106);
    const j = joints(plan);
    expect(j).toMatchObject({ joints: 56, freeEnds: 97, extendedEnds: 51 });
    expect(j.maxExtension).toBeLessThan(0.21);
    const reasons = plan.report.skipped.map((s) => `${s.type}:${s.reason}`);
    expect(reasons.filter((r) => r === 'IfcFooting:footing-without-member-end')).toHaveLength(9);
    expect(reasons.filter((r) => !r.startsWith('IfcFooting'))).toEqual(['IfcWallStandardCase:no-idealisable-shape']);

    applyStructuralDerivation(editor, store, plan);
    const { content } = new StepExporter(store, editor.getMutationView()).export({ schema: 'IFC2X3', applyMutations: true });
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    const out = process.env.STRUCTURAL_DERIVE_OUT;
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'derived-bimcollab-str.ifc'), text); }
    const data = extractStructuralOnDemand(await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true }));
    expect(data.members).toHaveLength(142 + 118);
    expect(data.connections).toHaveLength(plan.nodes.length);
    expect(data.analysisModels[0].itemGlobalIds).toHaveLength(142 + 118 + plan.nodes.length);
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

  it.skipIf(!has(AC20))('AC-20: columns and beams share joints, and every end left free is reported', async () => {
    const { store, editor } = await load(AC20);
    const plan = planStructuralDerivation(readStructuralDerivationFacts(store, editor));
    expect(plan.nodes).toHaveLength(60);
    // Before joints: 60 nodes, none shared, and no free end reported.
    const j = joints(plan);
    expect(j).toMatchObject({ joints: 20, freeEnds: 20, extendedEnds: 20 });
    expect(j.maxExtension).toBeLessThan(0.1);
    expect(plan.report.counts.freeEnds).toBe(20);
  });
});

describe('derived against authored analytical models (#9668)', () => {
  /** Per element, the largest distance from a derived member end to the nearest end of its authored members. */
  async function curveErrors(path: string) {
    const { store, editor, plan, authored } = await deriveBesideAuthored(path);
    const geometry = authoredReader(store, editor);
    const errors = new Map<number, number>();
    for (const member of plan.curveMembers) {
      const counterparts = structuralCounterparts(authored, member.elementId)!.expressIds
        .filter((id) => geometry.read(id)?.type.toUpperCase() === 'IFCSTRUCTURALCURVEMEMBER');
      // Authored members split at intermediate nodes: compare with the nearest authored end.
      const ends = counterparts.flatMap((id) => geometry.edge(id));
      const error = Math.max(...[member.start, member.end].map((p) => Math.min(...ends.map((q) => distance(p, q)))));
      errors.set(member.elementId, Math.max(errors.get(member.elementId) ?? 0, error));
    }
    const sorted = [...errors.values()].sort((a, b) => a - b);
    return { plan, errors: sorted };
  }

  it.skipIf(!has(STEEL_FRAME))('steel frame: every beam and column matches its authored members within 0.05 m', async () => {
    const { plan, errors } = await curveErrors(STEEL_FRAME);
    expect(errors).toHaveLength(86);
    expect(plan.curveMembers).toHaveLength(130);
    expect(errors[errors.length - 1]).toBeLessThan(0.05);
    expect(errors[Math.floor(errors.length / 2)]).toBeLessThan(0.005);
    expect(errors[Math.floor(errors.length * 0.9)]).toBeLessThan(0.015);
    expect(plan.report.counts).toMatchObject({ nodes: 94, guessedSupports: 6 });
    expect(joints(plan)).toMatchObject({ joints: 58, freeEnds: 34, extendedEnds: 0 });
  });

  it.skipIf(!has(ROOF_TRUSS))('roof truss: every member matches its authored members within 1 mm once its joints are made', async () => {
    const { plan, errors } = await curveErrors(ROOF_TRUSS);
    expect(errors).toHaveLength(10);
    // 0.150 m before the joint rule: two diagonals stopped at a chord's face.
    expect(errors[errors.length - 1]).toBeLessThan(0.001);
    expect(plan.report.counts).toMatchObject({ curveMembers: 13, nodes: 10 });
    expect(joints(plan)).toMatchObject({ joints: 7, freeEnds: 1, extendedEnds: 2 });
  });

  it.skipIf(!has(E1_3))('E1--3: the four columns match their authored members, and the slab its plane', async () => {
    const { plan, errors } = await curveErrors(E1_3);
    expect(errors).toHaveLength(4);
    expect(errors[errors.length - 1]).toBeLessThan(0.001);
    expect(plan.surfaceMembers).toHaveLength(1);
    expect(plan.report.counts).toMatchObject({ nodes: 8, supports: 4, guessedSupports: 4 });
    // The columns stop under the slab, and a surface member gets no connections: four free tops.
    expect(joints(plan)).toMatchObject({ joints: 0, freeEnds: 4 });
  });

  it.skipIf(!has(STEEL_FRAME))('steel frame with one top beam unlinked: no support guessed under it, and the authored model is refused, then added beside', async () => {
    const { store, editor } = await load(STEEL_FRAME);
    const facts = readStructuralDerivationFacts(store, editor);
    expect(facts.existingAnalysisModels).toMatchObject([{ derived: false }]);
    // The highest beam, read from a plan of the whole frame.
    const whole = planStructuralDerivation({ ...facts, elements: facts.elements.map((e) => ({ ...e, idealised: false })) });
    const beams = whole.curveMembers.filter((m) => facts.elements.find((e) => e.expressId === m.elementId)!.type.startsWith('IfcBeam'));
    const top = beams.reduce((a, b) => (Math.min(a.start[2], a.end[2]) >= Math.min(b.start[2], b.end[2]) ? a : b)).elementId;
    // Remove the links between that beam and its authored members.
    const read = createStyleEntityReader(store, editor);
    const links = [...iterateEffectiveEntityIds(store, editor.getMutationView(), ['IFCRELASSIGNSTOPRODUCT'])]
      .filter(({ expressId }) => JSON.stringify(read(expressId)!.attributes).includes(`"#${top}"`) || refId(read(expressId)!.attributes[6]) === top);
    expect(links.length).toBeGreaterThan(0);
    for (const { expressId } of links) editor.removeEntity(expressId);
    const partial = readStructuralDerivationFacts(store, editor);
    const plan = planStructuralDerivation(partial);
    expect(new Set(plan.curveMembers.map((m) => m.elementId))).toEqual(new Set([top]));
    expect(Math.min(...plan.nodes.map((n) => n.position[2]))).toBeGreaterThan(4);
    expect(plan.report.guessedSupports).toEqual([]);
    const before = editor.getNewEntities().length;
    expect(() => applyStructuralDerivation(editor, store, plan)).toThrow(/already has an analysis model/);
    expect(editor.getNewEntities().length).toBe(before);
    applyStructuralDerivation(editor, store, planStructuralDerivation(partial, { whenAnalysisModelExists: 'add' }));
    expect(liveStructuralExtraction(store, editor.getMutationView()).analysisModels).toHaveLength(2);
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
