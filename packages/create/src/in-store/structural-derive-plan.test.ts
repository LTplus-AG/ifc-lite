/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9668: each derivation rule, positive and negative, on synthetic physical facts.
import { describe, expect, it } from 'vitest';
import { planStructuralDerivation } from './structural-derive-plan.js';
import type { PhysicalElementFact, PrismFact, StructuralDerivationFacts, StructuralDerivationPlan, Vec3 } from './structural-derive-types.js';

/** Axis-aligned prism: a rectangle in XY at `base`, swept by `extrusion`. */
function box(base: Vec3, x: number, y: number, extrusion: Vec3, outlineExact = true): PrismFact {
  const [bx, by, bz] = base;
  return { outline: [[bx, by, bz], [bx + x, by, bz], [bx + x, by + y, bz], [bx, by + y, bz]], extrusion, outlineExact };
}
let nextId = 100;
function element(type: string, shape: Partial<PhysicalElementFact>, more: Partial<PhysicalElementFact> = {}): PhysicalElementFact {
  return { expressId: nextId++, type, name: null, storeyId: 1, loadBearing: true, idealised: false, ...shape, ...more };
}
/** A footing's body bounds, from its corner and size. */
const footingAt = (min: Vec3, size: Vec3) =>
  element('IfcFooting', { bounds: { min, max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]] } }, { loadBearing: null });
/** A 0.3 x 0.3 column from z0 to z1 centred on (x, y). */
const column = (x: number, y: number, z0: number, z1: number, more: Partial<PhysicalElementFact> = {}) =>
  element('IfcColumn', { prism: box([x - 0.15, y - 0.15, z0], 0.3, 0.3, [0, 0, z1 - z0]) }, more);
/** A beam along X at height z, from x0 to x1, given by its Axis representation. */
const beam = (x0: number, x1: number, y: number, z: number, more: Partial<PhysicalElementFact> = {}) =>
  element('IfcBeam', { axis: [[x0, y, z], [x1, y, z]] }, more);
/** A curve element given by its Axis representation. */
const line = (type: string, a: Vec3, b: Vec3) => element(type, { axis: [a, b] });
/** The x of each support, ascending. */
const supportXs = (plan: StructuralDerivationPlan) => plan.nodes.filter((n) => n.support).map((n) => +n.position[0].toFixed(6) + 0).sort((a, b) => a - b);
const facts = (...elements: PhysicalElementFact[]): StructuralDerivationFacts => ({ elements, defaultStoreyId: 1, existingAnalysisModels: [] });

describe('structural derivation plan (#9668)', () => {
  it('uses the Axis representation of a beam when present', () => {
    const plan = planStructuralDerivation(facts(beam(0, 6, 0, 3)));
    expect(plan.curveMembers).toMatchObject([{ axisSource: 'axis', start: [0, 0, 3], end: [6, 0, 3] }]);
    expect(plan.nodes).toHaveLength(2);
  });

  it('falls back to the extrusion axis through the profile centre', () => {
    const plan = planStructuralDerivation(facts(column(2, 3, 0, 3)));
    const [member] = plan.curveMembers;
    expect(member.axisSource).toBe('extrusion');
    expect(member.start.map((v) => +v.toFixed(9))).toEqual([2, 3, 0]);
    expect(member.end.map((v) => +v.toFixed(9))).toEqual([2, 3, 3]);
  });

  it('reads a beam drawn in elevation along its long near-rectangular profile', () => {
    // Profile 6 m x 0.4 m in the XZ plane, extruded 0.2 m along Y.
    const prism: PrismFact = { outline: [[0, 0, 0], [6, 0, 0], [6, 0, 0.4], [0, 0, 0.4]], extrusion: [0, 0.2, 0], outlineExact: true };
    const plan = planStructuralDerivation(facts(element('IfcBeam', { prism })));
    expect(plan.curveMembers[0].axisSource).toBe('profile');
    expect(plan.curveMembers[0].start.map((v) => +v.toFixed(9))).toEqual([0, 0.1, 0.2]);
    expect(plan.curveMembers[0].end.map((v) => +v.toFixed(9))).toEqual([6, 0.1, 0.2]);
  });

  it('skips a member longest across a profile that is not a near-rectangle, or with no shape', () => {
    // An L-shaped plate, 4 x 4, extruded 0.2: longest across the profile, area 7/16 of its bounds.
    const prism: PrismFact = { outline: [[0, 0, 0], [4, 0, 0], [4, 1, 0], [1, 1, 0], [1, 4, 0], [0, 4, 0]], extrusion: [0, 0, 0.2], outlineExact: true };
    const plan = planStructuralDerivation(facts(
      element('IfcMember', { prism }),
      element('IfcBeam', { shapeIssue: 'Body is IFCTRIANGULATEDFACESET, not an extrusion' }),
    ));
    expect(plan.curveMembers).toHaveLength(0);
    expect(plan.report.skipped.map((s) => [s.type, s.reason])).toEqual([['IfcMember', 'no-idealisable-shape'], ['IfcBeam', 'no-idealisable-shape']]);
    expect(plan.report.skipped[1].detail).toMatch(/TRIANGULATEDFACESET/);
  });

  it('puts a slab on its mid-plane with its depth as thickness', () => {
    const plan = planStructuralDerivation(facts(element('IfcSlab', { prism: box([0, 0, 2.8], 5, 4, [0, 0, 0.2]) })));
    expect(plan.surfaceMembers).toHaveLength(1);
    expect(plan.surfaceMembers[0].thickness).toBeCloseTo(0.2);
    expect(plan.surfaceMembers[0].boundary.every((p) => Math.abs(p[2] - 2.9) < 1e-9)).toBe(true);
  });

  it('puts a wall on the centre line of its profile, swept up its height', () => {
    // 5 m long, 0.25 m thick footprint, 3 m tall.
    const plan = planStructuralDerivation(facts(element('IfcWall', { prism: box([0, 0, 0], 5, 0.25, [0, 0, 3]) })));
    const [wall] = plan.surfaceMembers;
    expect(wall.thickness).toBeCloseTo(0.25);
    expect(wall.boundary.map((p) => p.map((v) => +v.toFixed(9)))).toEqual([[0, 0.125, 0], [5, 0.125, 0], [5, 0.125, 3], [0, 0.125, 3]]);
  });

  it('skips oblique, bounds-only and self-intersecting surfaces', () => {
    const bowtie: PrismFact = { outline: [[0, 0, 0], [4, 3, 0], [4, 0, 0], [0, 4, 0]], extrusion: [0, 0, 0.2], outlineExact: true };
    const plan = planStructuralDerivation(facts(
      element('IfcSlab', { prism: box([0, 0, 0], 4, 4, [1, 0, 0.2]) }),
      element('IfcSlab', { prism: box([0, 0, 0], 4, 4, [0, 0, 0.2], false) }),
      element('IfcSlab', { prism: bowtie }),
    ));
    expect(plan.surfaceMembers).toHaveLength(0);
    expect(plan.report.skipped.map((s) => s.detail)).toEqual([
      'the extrusion is oblique to its profile',
      'the profile outline is known only as bounds',
      expect.stringMatching(/Structural Face/),
    ]);
  });

  it('follows LoadBearing, and the unknown-policy setting when it is absent', () => {
    const elements = [beam(0, 6, 0, 3, { loadBearing: false }), beam(0, 6, 5, 3, { loadBearing: null })];
    const included = planStructuralDerivation(facts(...elements));
    expect(included.curveMembers.map((m) => m.loadBearing)).toEqual(['assumed']);
    expect(included.report.skipped.map((s) => s.reason)).toEqual(['not-load-bearing']);
    expect(included.report.counts.assumedLoadBearing).toBe(1);
    const skipped = planStructuralDerivation(facts(...elements), { whenLoadBearingUnknown: 'skip' });
    expect(skipped.curveMembers).toHaveLength(0);
    expect(skipped.report.skipped.map((s) => s.reason)).toEqual(['not-load-bearing', 'load-bearing-unknown']);
  });

  it('merges member ends within the tolerance into one node at their mean', () => {
    const plan = planStructuralDerivation(facts(column(0, 0, 0, 3), beam(0.02, 6, 0, 3), beam(-6, -0.03, 0, 3)));
    expect(plan.nodes).toHaveLength(4);
    const top = plan.nodes.find((n) => n.elementIds.length === 3)!;
    [-0.01 / 3, 0, 3].forEach((v, i) => expect(top.position[i]).toBeCloseTo(v, 9));
    // Every member end sits on its node.
    for (const m of plan.curveMembers) {
      expect(m.start).toEqual(plan.nodes[m.startNode].position);
      expect(m.end).toEqual(plan.nodes[m.endNode].position);
    }
  });

  it('keeps ends further apart than the tolerance as separate nodes', () => {
    const near = planStructuralDerivation(facts(beam(0, 6, 0, 3), beam(6.04, 12, 0, 3)));
    const far = planStructuralDerivation(facts(beam(0, 6, 0, 3), beam(6.06, 12, 0, 3)));
    expect(near.nodes).toHaveLength(3);
    expect(far.nodes).toHaveLength(4);
    expect(planStructuralDerivation(facts(beam(0, 6, 0, 3), beam(6.06, 12, 0, 3)), { tolerance: 0.1 }).nodes).toHaveLength(3);
  });

  it('skips a member shorter than the tolerance', () => {
    const plan = planStructuralDerivation(facts(beam(0, 0.04, 0, 3)));
    expect(plan.curveMembers).toHaveLength(0);
    expect(plan.report.skipped[0].reason).toBe('shorter-than-tolerance');
  });

  it('puts a support on a column end inside a footing, linked to it, not guessed', () => {
    const footing = footingAt([-0.6, -0.6, -0.5], [1.2, 1.2, 0.5]);
    const lonely = footingAt([10, 10, -0.5], [1, 1, 0.5]);
    const plan = planStructuralDerivation(facts(column(0, 0, 0, 3), footing, lonely));
    expect(plan.nodes.map((n) => n.support)).toEqual([{ type: 'pinned', basis: 'footing', footingId: footing.expressId, guessed: false }, undefined]);
    expect(plan.report.guessedSupports).toEqual([]);
    expect(plan.report.skipped).toMatchObject([{ elementId: lonely.expressId, reason: 'footing-without-member-end' }]);
  });

  it('guesses supports at the lowest nodes when no footing carries one, and flags them', () => {
    const plan = planStructuralDerivation(facts(column(0, 0, 0, 3), column(6, 0, 0.03, 3), beam(0, 6, 0, 3)), { supportType: 'fixed' });
    const supported = plan.nodes.filter((n) => n.support);
    expect(supported.map((n) => n.position[2])).toEqual([0, 0.03]);
    expect(supported.every((n) => n.support?.guessed && n.support.basis === 'lowest-level' && n.support.type === 'fixed')).toBe(true);
    expect(plan.report.guessedSupports).toEqual(supported.map((n) => n.index));
  });

  it('guesses a flat tie to bear where rafters are drawn down to it, not under a post resting on it or at its overhang tips', () => {
    // A king-post truss: the tie overhangs both heels, the rafters are drawn to the tie axis, the post from its top face.
    const tie = line('IfcBeam', [-0.4, 0, 0], [6.4, 0, 0]);
    const truss = [tie, line('IfcBeam', [0, 0, 0], [3, 0, 1.5]), line('IfcBeam', [6, 0, 0], [3, 0, 1.5])];
    const plan = planStructuralDerivation(facts(...truss, line('IfcColumn', [3, 0, 0.15], [3, 0, 1.5])), { jointReach: 0.2 });
    expect(plan.report.extendedEnds.map((e) => +e.distance.toFixed(9))).toEqual([0.15]); // the post's foot, moved onto the tie axis
    const supports = plan.nodes.filter((n) => n.support).map((n) => n.position.map((v) => +v.toFixed(9) + 0));
    expect(supports.sort((a, b) => a[0] - b[0])).toEqual([[0, 0, 0], [6, 0, 0]]);
    // The overhang tips are cantilever ends now, not supports.
    expect(plan.report.freeEnds.map((i) => +plan.nodes[i].position[0].toFixed(9)).sort((a, b) => a - b)).toEqual([-0.4, 6.4]);
    // A post drawn down to the level bears like the rafters.
    expect(planStructuralDerivation(facts(...truss, line('IfcColumn', [3, 0, 0], [3, 0, 1.5]))).report.counts.guessedSupports).toBe(3);
  });

  it('keeps every column drawn to the level as a bearing on a straight ground beam, and every node of a run its bearings do not hold, and a wall under a run', () => {
    const grade = beam(0, 12, 0, 0);
    const frame = planStructuralDerivation(facts(grade, column(0, 0, 0, 3), column(6, 0, 0, 3), column(12, 0, 0, 3), beam(0, 12, 0, 3)));
    expect(supportXs(frame)).toEqual([0, 6, 12]);
    // A mono-pitch truss: one rafter alone would leave the tie a mechanism, so every tie node bears.
    const mono = planStructuralDerivation(facts(line('IfcBeam', [0, 0, 0], [6, 0, 0]), line('IfcBeam', [0, 0, 0], [6, 0, 3]),
      line('IfcColumn', [6, 0, 0.15], [6, 0, 3])), { jointReach: 0.2 });
    expect(mono.report.counts.guessedSupports).toBe(2);
    // An L of ground beams with two columns on one leg: pinned on one line, the other leg could turn, so every node bears.
    const ell = planStructuralDerivation(facts(beam(0, 6, 0, 0), line('IfcBeam', [6, 0, 0], [6, 6, 0]), column(0, 0, 0, 3), column(6, 0, 0, 3)));
    expect(ell.report.counts.guessedSupports).toBe(3);
    // Two close bearings first in node order do not set the line: the far bearing is on the line through the far pair.
    const close = planStructuralDerivation(facts(line('IfcBeam', [-1, 0, 0], [12, 0, 0]), line('IfcBeam', [12, 0, 0], [12, 6, 0]),
      column(0, 0, 0, 3), column(0.3, 0.012, 0, 3), column(12, 0, 0, 3)));
    expect(close.nodes.filter((n) => n.support).map((n) => n.position.map((v) => +v.toFixed(1) + 0)))
      .toEqual([[-1, 0, 0], [0, 0, 0], [0.3, 0, 0], [12, 0, 0], [12, 6, 0]]);
    // A grade beam whose far end rests on a wall: the wall top is a bearing, so that end is no cantilever.
    const ground = element('IfcBeam', { prism: box([0, -0.15, -0.15], 20, 0.3, [0, 0, 0.3]) });
    const wall = element('IfcWall', { prism: box([19.9, -1, -3.15], 0.2, 2, [0, 0, 3]) });
    const walled = planStructuralDerivation(facts(ground, line('IfcBeam', [0, 0, 0], [0, 6, 0]), wall,
      column(0, 0, 0, 3), column(10, 0, 0, 3), column(0, 6, 0, 3)));
    expect(walled.nodes.filter((n) => n.support).map((n) => n.position.map((v) => +v.toFixed(6) + 0)))
      .toEqual(expect.arrayContaining([[20, 0, 0]]));
    expect(walled.nodes.filter((n) => n.position[2] < 0.05 && !n.support)).toEqual([]);
    // A wide, shallow grade beam: a wall 0.3 m under its underside does not hold it, however wide the beam.
    const wide = element('IfcBeam', { prism: box([-1, -0.5, -0.1], 13, 1, [0, 0, 0.2]) });
    const gap = element('IfcWall', { prism: box([11.9, -1, -3.4], 0.2, 2, [0, 0, 3]) });
    const shallow = planStructuralDerivation(facts(wide, gap, column(0, 0, 0, 3), column(6, 0, 0, 3)));
    expect(supportXs(shallow)).toEqual([0, 6]);
    // A slab 0.1 m under that underside is no bearing either: the tolerance counts once.
    const slabGap = element('IfcSlab', { prism: box([11, -1, -0.5], 2, 2, [0, 0, 0.3]) });
    expect(supportXs(planStructuralDerivation(facts(wide, slabGap, column(0, 0, 0, 3), column(6, 0, 0, 3)), { tolerance: 0.06 }))).toEqual([0, 6]);
    // A slab whose edge the run end sits on, and a slab thinner than the tolerance, both hold it.
    const holdsEnd = (slab: PhysicalElementFact) => supportXs(planStructuralDerivation(facts(wide, slab, column(0, 0, 0, 3), column(6, 0, 0, 3))));
    expect(holdsEnd(element('IfcSlab', { prism: box([10, -1, -0.4], 2, 2, [0, 0, 0.3]) }))).toEqual([0, 6, 12]);
    expect(holdsEnd(element('IfcSlab', { prism: box([11, -1, -0.13], 2, 2, [0, 0, 0.03]) }))).toEqual([0, 6, 12]);
    // The underside is the body's, not half its height under the axis: an axis 0.1 m above it, a thin slab touching it.
    const offAxis = element('IfcBeam', { axis: [[-1, 0, 0], [12, 0, 0]], prism: box([-1, -0.1, -0.1], 13, 0.2, [0, 0, 0.4]) });
    const thin = element('IfcSlab', { prism: box([11, -1, -0.13], 2, 2, [0, 0, 0.03]) });
    expect(supportXs(planStructuralDerivation(facts(offAxis, thin, column(0, 0, 0, 3), column(6, 0, 0, 3))))).toEqual([0, 6, 12]);
    // Where a deep and a shallow beam meet, a slab under the shallow one holds the node.
    const deep = element('IfcBeam', { axis: [[0, 0, 0], [6, 0, 0]], prism: box([0, -0.15, -0.6], 6, 0.3, [0, 0, 0.8]) });
    const shallowBeam = element('IfcBeam', { axis: [[6, 0, 0], [12, 0, 0]], prism: box([6, -0.15, -0.2], 6, 0.3, [0, 0, 0.4]) });
    const slab = element('IfcSlab', { prism: box([6, -1, -0.5], 6.5, 2, [0, 0, 0.3]) });
    expect(supportXs(planStructuralDerivation(facts(deep, shallowBeam, slab, column(0, 0, 0, 3), column(3, 0, 0, 3))))).toEqual([0, 3, 6, 12]);
    // A wall drawn up into a pocket to the beam's axis holds its end too.
    const pocket = element('IfcWall', { prism: box([11.9, -1, -3], 0.2, 2, [0, 0, 3]) });
    expect(supportXs(planStructuralDerivation(facts(wide, pocket, column(0, 0, 0, 3), column(6, 0, 0, 3))))).toEqual([0, 6, 12]);
    // A basement wall the beam frames into, rising past it, holds its end as well.
    const basement = element('IfcWall', { prism: box([11.9, -1, -3], 0.2, 2, [0, 0, 6]) });
    expect(supportXs(planStructuralDerivation(facts(wide, basement, column(0, 0, 0, 3), column(6, 0, 0, 3))))).toEqual([0, 6, 12]);
    // A footing under the beam's underside holds its end, though the node lies outside it.
    const deepGround = element('IfcBeam', { axis: [[0, 0, 0], [12, 0, 0]], prism: box([0, -0.15, -0.3], 12, 0.3, [0, 0, 0.3]) });
    expect(supportXs(planStructuralDerivation(facts(deepGround, footingAt([11.5, -0.5, -1.3], [1, 1, 1]), column(0, 0, 0, 3), column(6, 0, 0, 3))))).toEqual([0, 6, 12]);
    // A tapered body under a straight Axis: the soffit rises from -0.6 at x=-1 to -0.1 at x=12. A slab whose top
    // is the soffit at x=12 holds that end; the probe there must use the local soffit, not the body's lowest z.
    const tapered = element('IfcBeam', { axis: [[-1, 0, 0], [12, 0, 0]], prism: {
      outline: [[-1, -0.15, -0.6], [12, -0.15, -0.1], [12, -0.15, 0.3], [-1, -0.15, 0.3]], extrusion: [0, 0.3, 0], outlineExact: true } });
    const soffitSlab = element('IfcSlab', { prism: box([11, -1, -0.4], 2, 2, [0, 0, 0.3]) });
    expect(supportXs(planStructuralDerivation(facts(tapered, soffitSlab, column(0, 0, 0, 3), column(6, 0, 0, 3))))).toEqual([0, 6, 12]);
    // A column derived before still bears the run end it rises from.
    const partial = planStructuralDerivation(facts(line('IfcBeam', [-1, 0, 0], [12, 0, 0]), column(0, 0, 0, 3), column(6, 0, 0, 3),
      column(12, 0, 0, 3, { idealised: true })));
    expect(supportXs(partial)).toEqual([0, 6, 12]);
    // A wall derived before, and a column derived before within the set joint reach, still hold the run ends.
    const held = planStructuralDerivation(facts(line('IfcBeam', [-1, 0, 0], [12, 0, 0]), column(0, 0, 0, 3), column(6, 0, 0, 3),
      element('IfcWall', { prism: box([11.9, -1, -3.05], 0.2, 2, [0, 0, 3]) }, { idealised: true }),
      element('IfcColumn', { axis: [[-1.15, 0, 0], [-1.15, 0, 3]] }, { idealised: true })), { jointReach: 0.2 });
    expect(supportXs({ ...held, nodes: held.nodes.filter((n) => n.position[2] < 0.05) })).toEqual([-1, 0, 6, 12]);
    // A slab derived before holds the run end, but not through its opening.
    const slabUnder = (openings: PhysicalElementFact['openings']) => planStructuralDerivation(facts(line('IfcBeam', [-1, 0, 0], [12, 0, 0]),
      column(0, 0, 0, 3), column(6, 0, 0, 3), element('IfcSlab', { prism: box([10, -2, -0.3], 4, 4, [0, 0, 0.3]), openings }, { idealised: true })));
    expect(supportXs(slabUnder([]))).toEqual([0, 6, 12]);
    expect(supportXs(slabUnder([{ expressId: 9001, name: 'hole', prism: box([11.5, -0.5, -0.4], 1, 1, [0, 0, 0.5]) }]))).toEqual([0, 6]);
    // A column derived before beside the run, off the line of its members, holds nothing, however far the reach.
    const beside = planStructuralDerivation(facts(line('IfcBeam', [0, 0, 0], [12, 0, 0]), column(0, 0, 0, 3), column(6, 0, 0, 3),
      element('IfcColumn', { axis: [[13.5, 1, 0], [13.5, 1, 3]] }, { idealised: true })), { jointReach: 2 });
    expect(supportXs(beside)).toEqual([0, 6]);
    // A wall standing on an Axis-only ground beam does not hold it, even with its base drawn 2 cm under the axis.
    expect(supportXs(planStructuralDerivation(facts(line('IfcBeam', [0, 0, 0], [12, 0, 0]), column(0, 0, 0, 3), column(6, 0, 0, 3),
      element('IfcWall', { prism: box([7, -0.1, -0.02], 6, 0.2, [0, 0, 3]) }))))).toEqual([0, 6]);
    const standing = planStructuralDerivation(facts(line('IfcBeam', [0, 0, 0], [12, 0, 0]), column(0, 0, 0, 3), column(6, 0, 0, 3),
      element('IfcWall', { prism: box([7, -0.1, 0], 6, 0.2, [0, 0, 3]) })));
    expect(supportXs(standing)).toEqual([0, 6]);
    // A column derived before at one end of a short flat piece bears that end only.
    const shortPiece = planStructuralDerivation(facts(line('IfcBeam', [-1, 0, 0], [12, 0, 0]), line('IfcBeam', [12, 0, 0], [13.5, 0, 0]),
      column(0, 0, 0, 3), column(6, 0, 0, 3), element('IfcColumn', { axis: [[13.5, 0, 0], [13.5, 0, 3]] }, { idealised: true })), { jointReach: 2 });
    expect(supportXs(shortPiece)).toEqual([0, 6, 13.5]);
    // A flat beam derived before is no column: it bears no run end, whichever way its ends are stored.
    for (const axis of [[[12, 0, 0], [20, 0, 0]], [[20, 0, 0], [12, 0, 0]]] as [Vec3, Vec3][]) {
      const flat = planStructuralDerivation(facts(line('IfcBeam', [-1, 0, 0], [12, 0, 0]), column(0, 0, 0, 3), column(6, 0, 0, 3),
        element('IfcBeam', { axis }, { idealised: true })));
      expect(supportXs(flat)).toEqual([0, 6]);
    }
    // A lone flat beam: nothing bears on it, both ends are supports.
    expect(planStructuralDerivation(facts(beam(0, 6, 0, 0))).report.counts.guessedSupports).toBe(2);
  });

  it('connects an end that lands on a member interior by splitting that member, and reports ends resting on a surface member', () => {
    const slab = element('IfcSlab', { prism: box([4, -2, 2.9], 4, 4, [0, 0, 0.2]) });
    const main = beam(0, 6, 0, 3);
    const secondary = beam(3, 3, -4, 3, { axis: [[3, -4, 3], [3, 0, 3]] });
    // The ground column keeps the guessed supports away from the ends under test.
    const plan = planStructuralDerivation(facts(main, secondary, column(6, 1, 3, 6), slab, column(20, 20, 0, 3)));
    expect(plan.curveMembers.filter((m) => m.elementId === main.expressId).map((m) => [m.start[0], m.end[0]])).toEqual([[0, 3], [3, 6]]);
    const joint = plan.nodes.find((n) => n.position.every((v, k) => Math.abs(v - [3, 0, 3][k]) < 1e-9))!;
    expect(joint.elementIds.sort()).toEqual([main.expressId, secondary.expressId].sort());
    // The main beam's end and the upper column's foot rest on the slab; surface members get no connections.
    expect(plan.report.unconnectedEnds.map((u) => [u.landsOn, u.landsOnElementId])).toEqual([['surface-member', slab.expressId], ['surface-member', slab.expressId]]);
    expect(plan.nodes).toHaveLength(8);
  });

  it('splits a third member where a junction of two member ends lands on its interior', () => {
    const main = beam(0, 6, 0, 3);
    const plan = planStructuralDerivation(facts(main, beam(3, 3, -4, 3, { axis: [[3, -4, 3], [3, 0, 3]] }), beam(3, 3, 4, 3, { axis: [[3, 4, 3], [3, 0, 3]] }), column(20, 20, 0, 3)));
    expect(plan.curveMembers.filter((m) => m.elementId === main.expressId)).toHaveLength(2);
    expect(plan.nodes.filter((n) => n.elementIds.length === 3)).toHaveLength(1);
    expect(plan.report.unconnectedEnds).toEqual([]);
    expect(plan.report.extendedEnds).toEqual([]);
  });

  it('splits every member that passes through the joint, not only the first one met', () => {
    // Two beams cross at (0, 0, 3); a column ends there.
    const a = element('IfcBeam', { axis: [[-3, 0, 3], [3, 0, 3]] });
    const b = element('IfcBeam', { axis: [[0, -3, 3], [0, 3, 3]] });
    const plan = planStructuralDerivation(facts(a, b, column(0, 0, 0, 3)));
    expect(plan.curveMembers.filter((m) => m.elementId === a.expressId)).toHaveLength(2);
    expect(plan.curveMembers.filter((m) => m.elementId === b.expressId)).toHaveLength(2);
    expect(plan.nodes.filter((n) => n.elementIds.length === 3)).toHaveLength(1);
    // A member running along the column through the joint is not split there.
    const along = element('IfcMember', { axis: [[0, 0, 1], [0, 0, 6]] });
    const overlap = planStructuralDerivation(facts(a, b, column(0, 0, 0, 3), along));
    expect(overlap.curveMembers.filter((m) => m.elementId === along.expressId)).toHaveLength(1);
  });

  describe('joints between centroid axes', () => {
    /** Two 0.3 m columns, 0 to 3 m, at x = 0 and 6; a 0.3 x 0.4 m beam between their faces, top flush with theirs. */
    const portal = (beamY = 0, beamFrom = 0.15) => {
      const left = column(0, 0, 0, 3);
      const right = column(6, 0, 0, 3);
      const girder = element('IfcBeam', { prism: box([beamFrom, beamY - 0.15, 2.6], 5.85 - beamFrom, 0.3, [0, 0, 0.4]) });
      return { left, right, girder, all: [left, right, girder] };
    };
    const at = (plan: ReturnType<typeof planStructuralDerivation>, p: Vec3) => plan.nodes.find((n) => n.position.every((v, k) => Math.abs(v - p[k]) < 1e-6));

    it('moves the beam ends out and the column tops down, along their own axes, to one node per joint', () => {
      const { left, right, girder, all } = portal();
      const plan = planStructuralDerivation(facts(...all));
      expect(plan.nodes).toHaveLength(4);
      for (const [x, column] of [[0, left], [6, right]] as const) {
        expect(at(plan, [x, 0, 2.8])?.elementIds.sort()).toEqual([column.expressId, girder.expressId].sort());
      }
      const moves = plan.report.extendedEnds.map((e) => [e.elementId, e.end, +e.distance.toFixed(6), e.toElementId]);
      expect(moves).toEqual(expect.arrayContaining([
        [left.expressId, 'end', -0.2, girder.expressId], [right.expressId, 'end', -0.2, girder.expressId],
        [girder.expressId, 'start', 0.15, left.expressId], [girder.expressId, 'end', 0.15, right.expressId],
      ]));
      expect(plan.report.counts).toMatchObject({ extendedEnds: 4, freeEnds: 0, curveMembers: 3 });
    });

    it('never moves an end sideways: a beam axis 0.1 m beside the column axes meets nothing, and its ends are free', () => {
      const { girder, all } = portal(0.1);
      const plan = planStructuralDerivation(facts(...all));
      expect(plan.report.extendedEnds).toEqual([]);
      expect(plan.nodes.filter((n) => n.elementIds.length > 1)).toEqual([]);
      const free = plan.report.freeEnds.map((n) => plan.nodes[n].elementIds[0]);
      expect(free.filter((id) => id === girder.expressId)).toHaveLength(2);
      expect(plan.report.freeEnds).toHaveLength(4); // the beam's two ends and both column tops
    });

    it('moves an end only within the reach: half the other section plus tolerance, or jointReach', () => {
      // The beam stops 0.5 m short of the left column axis: beyond 0.15 + 0.05.
      const { all } = portal(0, 0.5);
      const plan = planStructuralDerivation(facts(...all));
      expect(plan.report.extendedEnds.map((e) => e.distance.toFixed(2))).toEqual(expect.not.arrayContaining(['0.50']));
      expect(at(plan, [0, 0, 2.8])).toBeUndefined();
      const reached = planStructuralDerivation(facts(...all), { jointReach: 0.6 });
      expect(at(reached, [0, 0, 2.8])?.elementIds).toHaveLength(2);
      expect(Math.max(...reached.report.extendedEnds.map((e) => Math.abs(e.distance)))).toBeCloseTo(0.5, 9);
    });

    it('guesses supports at the lowest nodes after the joints moved the ends', () => {
      // A 0.3 m deep grade beam between the column faces: the column feet move up to its axis at 0.15 m.
      const grade = element('IfcBeam', { prism: box([0.15, -0.15, 0], 5.7, 0.3, [0, 0, 0.3]) });
      const plan = planStructuralDerivation(facts(column(0, 0, 0, 3), column(6, 0, 0, 3), grade, beam(0, 6, 0, 3)));
      const supports = plan.nodes.filter((n) => n.support);
      expect(supports).toHaveLength(2);
      expect(supports.every((n) => Math.abs(n.position[2] - 0.15) < 1e-9 && n.support?.guessed)).toBe(true);
    });

    it('sets the level from members derived before, not from other elements this run leaves out', () => {
      // A ground column derived before sets the level even with no LoadBearing value and the skip policy.
      const upper = planStructuralDerivation(facts(column(0, 0, 0, 3, { loadBearing: null, idealised: true }), beam(0, 6, 0, 3)), { whenLoadBearingUnknown: 'skip' });
      expect(upper.report.guessedSupports).toEqual([]);
      // Under the skip policy an unknown element is not load-bearing: it does not set the level.
      const skipped = planStructuralDerivation(facts(column(0, 0, 0, 3, { loadBearing: null }), beam(0, 6, 0, 3)), { whenLoadBearingUnknown: 'skip' });
      expect(skipped.report.counts.guessedSupports).toBe(2);
      // A stub shorter than the tolerance, derived before, does not set it either.
      const stub = element('IfcMember', { axis: [[20, 0, -1], [20, 0, -0.97]] }, { idealised: true });
      expect(planStructuralDerivation(facts(column(0, 0, 0, 3), column(6, 0, 0, 3), beam(0, 6, 0, 3), stub)).report.counts.guessedSupports).toBe(2);
    });

    it('puts no support up a column where a brace foot was moved onto it, and ignores stubs shorter than the tolerance', () => {
      const brace = element('IfcMember', { axis: [[-0.1, 0, 0], [2.9, 0, 3]] });
      const stub = element('IfcMember', { axis: [[20, 0, -1], [20, 0, -0.97]] });
      const plan = planStructuralDerivation(facts(column(0, 0, 0, 3), column(6, 0, 0, 3), beam(0, 6, 0, 3), brace, stub));
      expect(plan.report.extendedEnds.map((e) => e.elementId)).toContain(brace.expressId);
      const supports = plan.nodes.filter((n) => n.support).map((n) => n.position.map((v) => +v.toFixed(6) + 0));
      expect(supports).toEqual(expect.arrayContaining([[0, 0, 0], [6, 0, 0]]));
      expect(supports).toHaveLength(2);
    });

    it('connects an end that already touches a member within the tolerance, even with jointReach 0', () => {
      const plan = planStructuralDerivation(facts(column(0, 0, 0, 3), beam(0.02, 6, 0, 1.5)), { jointReach: 0 });
      expect(plan.curveMembers).toHaveLength(3); // the column, split, and the beam
      expect(plan.report.unconnectedEnds).toEqual([]);
    });

    it('counts a split element without LoadBearing once as assumed', () => {
      const plan = planStructuralDerivation(facts(column(0, 0, 0, 6, { loadBearing: null }), beam(0, 6, 0, 2), beam(0, 6, 0, 4)));
      expect(plan.curveMembers).toHaveLength(5);
      expect(plan.report.counts.assumedLoadBearing).toBe(1);
    });

    it('does not report a split element as skipped when only one of its pieces collapses', () => {
      // Two beams stop at the column face and move onto its axis: one cuts it 0.07 m below its top (held by the
      // column above), the other lands between that cut and the top, chaining both into one node, so the short
      // top piece collapses.
      const col = column(0, 0, 0, 3);
      const above = column(0, 0, 3, 6);
      const plan = planStructuralDerivation(facts(col, above, beam(0.15, 6, 0, 2.93), beam(-6, -0.15, 0, 2.965)));
      expect(plan.report.extendedEnds.map((e) => e.elementId)).not.toContain(col.expressId);
      expect(plan.report.extendedEnds).toHaveLength(2);
      // The dropped piece's ends stay in their node: the column above still stands on the one below.
      expect(plan.nodes.some((n) => n.elementIds.includes(col.expressId) && n.elementIds.includes(above.expressId))).toBe(true);
      expect(plan.curveMembers.filter((m) => m.elementId === col.expressId)).toHaveLength(1);
      expect(plan.report.skipped.map((s) => s.elementId)).not.toContain(col.expressId);
    });

    it('lists every member end that meets no other member or support as a free end, whatever its distance', () => {
      const plan = planStructuralDerivation(facts(beam(0, 6, 0, 3), beam(0, 6, 40, 3), column(20, 20, 0, 3)));
      // Both beams float: four free ends. The column's foot is a guessed support, its top is free.
      expect(plan.report.counts.freeEnds).toBe(5);
    });
  });

  it('guesses supports by the lowest level of the whole load-bearing structure, already idealised members included', () => {
    // The ground floor column was derived before; only the upper floor column is new.
    const plan = planStructuralDerivation(facts(column(0, 0, 0, 3, { idealised: true }), column(0, 0, 3, 6)));
    expect(plan.curveMembers).toHaveLength(1);
    expect(plan.report.guessedSupports).toEqual([]);
    expect(plan.report.freeEnds).toHaveLength(2);
  });

  it('passes the analysis models already in the file through to the plan', () => {
    const existing = [{ expressId: 7, name: 'Authored', derived: false }];
    const plan = planStructuralDerivation({ ...facts(beam(0, 6, 0, 3)), existingAnalysisModels: existing });
    expect(plan.existingAnalysisModels).toEqual(existing);
    expect(plan.refusal).toMatch(/already has an analysis model \(#7\)/);
    expect(planStructuralDerivation({ ...facts(beam(0, 6, 0, 3)), existingAnalysisModels: existing }, { whenAnalysisModelExists: 'add' }).refusal).toBeNull();
    // Nothing to derive: nothing to refuse.
    expect(planStructuralDerivation({ ...facts(), existingAnalysisModels: existing }).refusal).toBeNull();
  });

  it('skips an element that already has a structural counterpart, so a re-run plans nothing', () => {
    const plan = planStructuralDerivation(facts(beam(0, 6, 0, 3, { idealised: true })));
    expect(plan.curveMembers).toHaveLength(0);
    expect(plan.report.skipped[0].reason).toBe('already-idealised');
  });

  it.each([NaN, 0, -1, 2, Infinity])('refuses tolerance %s', (tolerance) => {
    expect(() => planStructuralDerivation(facts(), { tolerance })).toThrow(/tolerance/);
  });

  it('refuses unknown settings', () => {
    expect(() => planStructuralDerivation(facts(), { supportType: 'roller' as 'pinned' })).toThrow(/supportType/);
    expect(() => planStructuralDerivation(facts(), { whenLoadBearingUnknown: 'maybe' as 'skip' })).toThrow(/whenLoadBearingUnknown/);
    expect(() => planStructuralDerivation(facts(), { whenAnalysisModelExists: 'replace' as 'add' })).toThrow(/whenAnalysisModelExists/);
  });

  it.each([NaN, -0.1, 3, Infinity, '0.2' as unknown as number])('refuses jointReach %s', (jointReach) => {
    expect(() => planStructuralDerivation(facts(), { jointReach })).toThrow(/jointReach/);
  });
});
