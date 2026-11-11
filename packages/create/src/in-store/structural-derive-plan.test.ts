/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9668: each derivation rule, positive and negative, on synthetic physical facts.
import { describe, expect, it } from 'vitest';
import { planStructuralDerivation } from './structural-derive-plan.js';
import type { PhysicalElementFact, PrismFact, StructuralDerivationFacts, Vec3 } from './structural-derive-types.js';

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

    it('sets the level from members derived before, not from elements this run skips', () => {
      // A ground column derived before sets the level even with no LoadBearing value and the skip policy.
      const upper = planStructuralDerivation(facts(column(0, 0, 0, 3, { loadBearing: null, idealised: true }), beam(0, 6, 0, 3)), { whenLoadBearingUnknown: 'skip' });
      expect(upper.report.guessedSupports).toEqual([]);
      // Under the skip policy an unknown element is not load-bearing: it does not set the level.
      const skipped = planStructuralDerivation(facts(column(0, 0, 0, 3, { loadBearing: null }), beam(0, 6, 0, 3)), { whenLoadBearingUnknown: 'skip' });
      expect(skipped.report.counts.guessedSupports).toBe(2);
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
    expect(plan.options.whenAnalysisModelExists).toBe('refuse');
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
