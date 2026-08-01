/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spatially coupled merge semantics (Bet B4.2, closing the G2 red-team
 * finding in docs/vision/reviews/g2-red-team-2026-07-24.md §4).
 *
 * The finding: merge-model.ts v0 applied every op purely per-node, so
 * node-disjoint ops commuted BY CONSTRUCTION and the spatial half of the
 * conflict predicate could not produce a true conflict even in principle --
 * 35 false and 0 true spatial-only flags in 1,000 schedules.
 *
 * These tests pin the coupling that makes the spatial rule falsifiable:
 * hosted openings must stay inside their host, `geometry-replace` on a host
 * re-cuts its openings, and both of those read state the op does not write.
 * The headline case is the last one in the "does not commute" block: two ops
 * with DISJOINT writtenNodes that genuinely diverge, caught by the spatial
 * rule alone.
 */

import { describe, expect, it } from 'vitest';
import { conflictPredicate } from '../src/footprint.js';
import {
  attemptBothOrders,
  createCommutationCertificate,
  verifyCommutationCertificate,
} from '../src/commutation.js';
import type { GeometryMeshPayload } from '../src/node-hash.js';
import {
  applyOp,
  buildStateDag,
  canonicalStateBytes,
  computeMergeOpFootprint,
  DEFAULT_MERGE_SEMANTICS,
  hashModelState,
  OpApplicationError,
  SpatialRejectionError,
  stripVoidMarkers,
  type EntityState,
  type MergeOp,
  type MergeSemantics,
  type ModelState,
} from '../src/merge-model.js';

const HOST_ID = 'element:wall';
const HOST_MESH = 'mesh:wall';
const VOID_ID = 'element:void';
const VOID_MESH = 'mesh:void';

function tri(expressId: number, origin: readonly [number, number, number], size: number): GeometryMeshPayload {
  return {
    expressId,
    geometryClass: 0,
    positions: [0, 0, 0, size, 0, 0, 0, size, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    origin,
  };
}

function entity(
  tag: string,
  ifcType: string,
  mesh: GeometryMeshPayload,
  hostId?: string,
): EntityState {
  const state: EntityState = {
    key: `GUID-${tag}`,
    ifcType,
    storeyId: 'S0',
    psets: new Map([[`pset:${tag}`, { name: 'Pset_Common', properties: [{ name: 'IsExternal', value: true }] }]]),
    meshes: new Map([[`mesh:${tag}`, mesh]]),
  };
  if (hostId !== undefined) state.hostId = hostId;
  return state;
}

/** A unit wall at the origin (box [0,1]x[0,1]x[0,0]) hosting one 0.2 m
 *  opening at [0.4,0.4] (box [0.4,0.6]^2) -- inset far enough from both faces
 *  that it can be moved legally in either direction. */
function hostedState(): ModelState {
  return {
    storeyIds: ['S0'],
    entities: new Map([
      [HOST_ID, entity('wall', 'IfcWall', tri(1, [0, 0, 0], 1))],
      [VOID_ID, entity('void', 'IfcOpeningElement', tri(2, [0.4, 0.4, 0], 0.2), HOST_ID)],
    ]),
  };
}

function moveHost(opId: string, dx: number, dy = 0): MergeOp {
  return { opId, type: 'geometry-replace', meshNodeId: HOST_MESH, payload: tri(1, [dx, dy, 0], 1) };
}

function moveOpening(opId: string, x: number, y: number): MergeOp {
  return { opId, type: 'geometry-replace', meshNodeId: VOID_MESH, payload: tri(2, [x, y, 0], 0.2) };
}

describe('containment: ops can be REJECTED on spatial grounds', () => {
  it('rejects a host move that would leave its opening outside', () => {
    const base = hostedState();
    // Host to [0.5,1.5]; the opening at [0.4,0.6] no longer fits.
    expect(() => applyOp(base, moveHost('a', 0.5))).toThrow(SpatialRejectionError);
    // Still an OpApplicationError, so every existing replay path handles it.
    expect(() => applyOp(base, moveHost('a', 0.5))).toThrow(OpApplicationError);
  });

  it('allows a host move that keeps its opening inside', () => {
    const base = hostedState();
    const next = applyOp(base, moveHost('a', 0.1, 0.1));
    expect(stripVoidMarkers(next.entities.get(HOST_ID)!.meshes.get(HOST_MESH)!).origin).toEqual([0.1, 0.1, 0]);
  });

  it('rejects an opening move that would leave its host', () => {
    const base = hostedState();
    expect(() => applyOp(base, moveOpening('b', 0.9, 0.4))).toThrow(SpatialRejectionError);
    expect(applyOp(base, moveOpening('b', 0.5, 0.5))).toBeTruthy();
  });

  it('rejects an entity-add whose opening does not fit its host, and accepts one that does', () => {
    const base = hostedState();
    const add = (x: number): MergeOp => ({
      opId: 'add',
      type: 'entity-add',
      entity: {
        entityNodeId: 'element:void2',
        key: 'GUID-void2',
        ifcType: 'IfcOpeningElement',
        storeyId: 'S0',
        hostId: HOST_ID,
        psets: [{ psetNodeId: 'pset:void2', payload: { name: 'Pset_Common', properties: [] } }],
        meshes: [{ meshNodeId: 'mesh:void2', payload: tri(3, [x, 0.1, 0], 0.2) }],
      },
    });
    expect(() => applyOp(base, add(0.95))).toThrow(SpatialRejectionError);
    expect(applyOp(base, add(0.1)).entities.has('element:void2')).toBe(true);
  });

  it('rejects an entity-add naming a host that does not exist', () => {
    const base = hostedState();
    expect(() =>
      applyOp(base, {
        opId: 'add',
        type: 'entity-add',
        entity: {
          entityNodeId: 'element:orphan',
          key: 'GUID-orphan',
          ifcType: 'IfcOpeningElement',
          storeyId: 'S0',
          hostId: 'element:nope',
          psets: [],
          meshes: [{ meshNodeId: 'mesh:orphan', payload: tri(4, [0, 0, 0], 0.2) }],
        },
      }),
    ).toThrow(SpatialRejectionError);
  });
});

describe('re-cut: geometry-replace on a host subtracts its openings', () => {
  it('records the clipped void in the host mesh, and stripping is its exact inverse', () => {
    const base = hostedState();
    const next = applyOp(base, moveHost('a', 0.1));
    const cut = next.entities.get(HOST_ID)!.meshes.get(HOST_MESH) as GeometryMeshPayload;
    // 3 base vertices (9 floats) + one void marker pair (6 floats).
    expect(Array.from(cut.positions)).toHaveLength(15);
    expect(Array.from(cut.normals)).toHaveLength(15);
    // Marker is the opening's box clipped to the host's, in the host's local
    // frame: opening [0.4,0.6]^2 minus the host origin [0.1,0,0].
    const marker = Array.from(cut.positions).slice(9);
    [0.3, 0.4, 0, 0.5, 0.6, 0].forEach((expected, i) => expect(marker[i]).toBeCloseTo(expected, 12));
    const stripped = stripVoidMarkers(cut);
    expect(Array.from(stripped.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(stripVoidMarkers(stripped)).toBe(stripped);
  });

  it('is a function of the openings AS THEY ARE AT RE-CUT TIME (a moved opening cuts differently)', () => {
    const base = hostedState();
    const cutBefore = applyOp(base, moveHost('a', 0.1)).entities.get(HOST_ID)!.meshes.get(HOST_MESH)!;
    const moved = applyOp(base, moveOpening('b', 0.5, 0.5));
    const cutAfter = applyOp(moved, moveHost('a', 0.1)).entities.get(HOST_ID)!.meshes.get(HOST_MESH)!;
    expect(Array.from(cutAfter.positions)).not.toEqual(Array.from(cutBefore.positions));
  });

  it('a host with no openings is untouched by the re-cut path', () => {
    const plain: ModelState = {
      storeyIds: ['S0'],
      entities: new Map([[HOST_ID, entity('wall', 'IfcWall', tri(1, [0, 0, 0], 1))]]),
    };
    const next = applyOp(plain, moveHost('a', 5));
    expect(Array.from(next.entities.get(HOST_ID)!.meshes.get(HOST_MESH)!.positions)).toHaveLength(9);
  });
});

describe('cascade: removing a host takes its openings with it', () => {
  it('deletes the hosted openings and declares them in the footprint', () => {
    const base = hostedState();
    const op: MergeOp = { opId: 'r', type: 'entity-remove', entityNodeId: HOST_ID };
    const next = applyOp(base, op);
    expect(next.entities.has(HOST_ID)).toBe(false);
    expect(next.entities.has(VOID_ID)).toBe(false);

    const fp = computeMergeOpFootprint(buildStateDag(base), base, op);
    // The cascade is a WRITE, so it is declared -- never a hidden one.
    expect(fp.writtenNodes.has(HOST_ID)).toBe(true);
    expect(fp.writtenNodes.has(VOID_ID)).toBe(true);
  });
});

describe('node-disjoint ops that genuinely do NOT commute (the B4.2 headline)', () => {
  it('host move + opening move: disjoint writtenNodes, divergent bytes, caught by the SPATIAL rule alone', async () => {
    const base = hostedState();
    const hostOp = moveHost('a0', 0.1, 0.1);
    const openingOp = moveOpening('b0', 0.5, 0.5);

    const dag = buildStateDag(base);
    const fpA = computeMergeOpFootprint(dag, base, hostOp);
    const fpB = computeMergeOpFootprint(dag, base, openingOp);
    // Neither op writes a node the other writes.
    for (const id of fpA.writtenNodes) expect(fpB.writtenNodes.has(id)).toBe(false);

    // Both orders apply cleanly -- and produce DIFFERENT bytes, because the
    // host's cut is lazy: whoever re-cut last wins.
    const ab = applyOp(applyOp(base, hostOp), openingOp);
    const ba = applyOp(applyOp(base, openingOp), hostOp);
    expect(canonicalStateBytes(ab)).not.toBe(canonicalStateBytes(ba));
    expect(attemptBothOrders(base, [hostOp], [openingOp]).status).toBe('diverged');

    // Only the spatial half of the predicate can see this.
    const verdict = conflictPredicate(fpA, fpB);
    expect(verdict.structural).toBe(false);
    expect(verdict.spatial).toBe(true);

    // ...and it is enough: no certificate is issued.
    const outcome = await createCommutationCertificate({ base, opsA: [hostOp], opsB: [openingOp] });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('conflict');
  });

  it('order-dependent REJECTION: one order applies, the reverse order does not', () => {
    const base = hostedState();
    // Host grows to [0.3,1.3]: still contains the opening at [0.4,0.6].
    const hostOp = moveHost('a0', 0.3);
    // Opening to [1.05,1.25]: inside the MOVED host, outside the original.
    const openingOp = moveOpening('b0', 1.05, 0.4);

    expect(() => applyOp(applyOp(base, hostOp), openingOp)).not.toThrow();
    expect(() => applyOp(applyOp(base, openingOp), hostOp)).toThrow(SpatialRejectionError);

    const truth = attemptBothOrders(base, [hostOp], [openingOp]);
    expect(truth.status).toBe('apply-failed');

    const dag = buildStateDag(base);
    const verdict = conflictPredicate(
      computeMergeOpFootprint(dag, base, hostOp),
      computeMergeOpFootprint(dag, base, openingOp),
    );
    expect(verdict.structural).toBe(false);
    expect(verdict.spatial).toBe(true);
  });

  it('two openings in the SAME host still commute (the coupling is not a blanket conflict)', () => {
    const base = applyOp(hostedState(), {
      opId: 'seed',
      type: 'entity-add',
      entity: {
        entityNodeId: 'element:void2',
        key: 'GUID-void2',
        ifcType: 'IfcOpeningElement',
        storeyId: 'S0',
        hostId: HOST_ID,
        psets: [{ psetNodeId: 'pset:void2', payload: { name: 'Pset_Common', properties: [] } }],
        meshes: [{ meshNodeId: 'mesh:void2', payload: tri(3, [0.05, 0.05, 0], 0.2) }],
      },
    });
    const a: MergeOp = moveOpening('a0', 0.5, 0.5);
    const b: MergeOp = { opId: 'b0', type: 'geometry-replace', meshNodeId: 'mesh:void2', payload: tri(3, [0.1, 0.1, 0], 0.2) };
    expect(attemptBothOrders(base, [a], [b]).status).toBe('converged');
  });
});

describe('a geometry-less opening is unconstrained, from BOTH entry points', () => {
  /**
   * `assertInsideHost` (the opening-side check, run on entity-add and on a
   * geometry-replace whose owner is hosted) and `assertOpeningsContained` (the
   * host-side check, run on a geometry-replace whose owner is a host) have to
   * agree about an opening that carries no geometry: it subtracts nothing, so
   * `recutHost` skips it, and neither check may reject on account of it.
   */
  function withEmptyOpening(): ModelState {
    const base = hostedState();
    return applyOp(base, {
      opId: 'seed',
      type: 'entity-add',
      entity: {
        entityNodeId: 'element:ghost',
        key: 'GUID-ghost',
        ifcType: 'IfcOpeningElement',
        storeyId: 'S0',
        hostId: HOST_ID,
        psets: [{ psetNodeId: 'pset:ghost', payload: { name: 'Pset_Common', properties: [] } }],
        meshes: [],
      },
    });
  }

  it('the opening-side check accepts the add', () => {
    expect(() => withEmptyOpening()).not.toThrow();
  });

  it('the host-side check accepts a host edit made while it is hosted', () => {
    const base = withEmptyOpening();
    const next = applyOp(base, moveHost('a0', 0.1, 0.1));
    // ...and it contributes no void marker, because it subtracts nothing.
    const host = next.entities.get(HOST_ID) as EntityState;
    const mesh = host.meshes.get(HOST_MESH) as GeometryMeshPayload;
    const base3 = stripVoidMarkers(mesh).positions.length;
    // Exactly one marker pair (6 floats) -- from the real opening, not two.
    expect(mesh.positions.length - base3).toBe(6);
  });
});

describe('a host with SEVERAL meshes: recutHost writes every one of them', () => {
  /**
   * The CodeRabbit finding on PR #1900, made concrete. `recutHost` rewrites
   * EVERY mesh of a host, with markers derived from EVERY opening the host
   * carries -- but a `geometry-replace` footprint used to declare only the
   * named mesh and to derive its region from that mesh alone. On the
   * single-mesh entities `merge-battery.ts` generates the two coincide, so the
   * gap was invisible; on a host whose meshes are spatially separated it is a
   * genuine unsound auto-merge, which is what this pins.
   *
   * A wall in two pieces 10 m apart, each with its own opening. Client A
   * nudges the NEAR piece; client B nudges the FAR piece's opening. Disjoint
   * node ids, and (before the fix) disjoint regions -- yet the two orders
   * record different cuts, because A's op re-cuts BOTH pieces against the
   * openings as they stand at that moment.
   */
  function splitHostState(): ModelState {
    const host = entity('wall', 'IfcWall', tri(1, [0, 0, 0], 1));
    host.meshes.set('mesh:wall:far', tri(2, [10, 0, 0], 1));
    return {
      storeyIds: ['S0'],
      entities: new Map([
        [HOST_ID, host],
        ['element:near', entity('near', 'IfcOpeningElement', tri(3, [0.3, 0.3, 0], 0.2), HOST_ID)],
        ['element:far', entity('far', 'IfcOpeningElement', tri(4, [10.2, 0.2, 0], 0.2), HOST_ID)],
      ]),
    };
  }

  const nearPieceOp: MergeOp = { opId: 'a0', type: 'geometry-replace', meshNodeId: HOST_MESH, payload: tri(1, [0.1, 0, 0], 1) };
  const farOpeningOp: MergeOp = {
    opId: 'b0',
    type: 'geometry-replace',
    meshNodeId: 'mesh:far',
    payload: tri(4, [10.5, 0.2, 0], 0.2),
  };

  it('the two orders genuinely diverge', () => {
    expect(attemptBothOrders(splitHostState(), [nearPieceOp], [farOpeningOp]).status).toBe('diverged');
  });

  it('the footprint declares EVERY mesh the re-cut writes, and the whole host as its region', () => {
    const base = splitHostState();
    const fp = computeMergeOpFootprint(buildStateDag(base), base, nearPieceOp);
    expect(fp.writtenNodes.has(HOST_MESH)).toBe(true);
    // The sibling mesh is written by the re-cut, so it is declared too.
    expect(fp.writtenNodes.has('mesh:wall:far')).toBe(true);
    // ...and the region covers the whole host, not just the named mesh's box,
    // because the markers it writes come from openings anywhere inside it.
    expect(fp.region?.max[0]).toBeGreaterThanOrEqual(11);
  });

  it('so the predicate REFUSES the pair instead of clearing it', async () => {
    const base = splitHostState();
    const dag = buildStateDag(base);
    const verdict = conflictPredicate(
      computeMergeOpFootprint(dag, base, nearPieceOp),
      computeMergeOpFootprint(dag, base, farOpeningOp),
    );
    expect(verdict.spatial).toBe(true);

    const outcome = await createCommutationCertificate({ base, opsA: [nearPieceOp], opsB: [farOpeningOp] });
    expect(outcome.ok).toBe(false);
    // 'conflict', not 'non-commutative': the PREDICATE caught it, not the
    // replay backstop. That is the whole distinction the B4.2 exam is stated
    // over.
    expect(outcome.ok === false && outcome.reason).toBe('conflict');
  });

  it('a host with no openings is not widened (the rule costs nothing where it buys nothing)', () => {
    const base = splitHostState();
    base.entities.delete('element:near');
    base.entities.delete('element:far');
    const fp = computeMergeOpFootprint(buildStateDag(base), base, nearPieceOp);
    expect(fp.writtenNodes.has('mesh:wall:far')).toBe(false);
    expect(fp.region?.max[0]).toBeLessThan(2);
  });
});

describe('the ablation, at unit scale (G4 review item 6)', () => {
  it('with the spatial rule DISABLED the predicate clears the headline non-commuting pair', async () => {
    const base = hostedState();
    const hostOp = moveHost('a0', 0.1, 0.1);
    const openingOp = moveOpening('b0', 0.5, 0.5);

    // Same pair as the B4.2 headline above: disjoint writtenNodes, divergent
    // bytes. With the rule off, nothing in the predicate can see it.
    const dag = buildStateDag(base);
    const ablated = conflictPredicate(
      computeMergeOpFootprint(dag, base, hostOp),
      computeMergeOpFootprint(dag, base, openingOp),
      { spatialRule: 'disabled' },
    );
    expect(ablated.conflict).toBe(false);

    // What stops it is then ONLY createCommutationCertificate's own replay of
    // both orders -- the backstop, not the predicate. That distinction is the
    // whole content of the ablation number: no unsound certificate is emitted
    // in either mode; the PREDICATE is what was wrong.
    const outcome = await createCommutationCertificate({
      base,
      opsA: [hostOp],
      opsB: [openingOp],
      spatialRule: 'disabled',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('non-commutative');
  });

  it('...and the order-dependent REJECTION case behaves the same way', async () => {
    const base = hostedState();
    const hostOp = moveHost('a0', 0.3);
    const openingOp = moveOpening('b0', 1.05, 0.4);
    const outcome = await createCommutationCertificate({
      base,
      opsA: [hostOp],
      opsB: [openingOp],
      spatialRule: 'disabled',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('apply-failed');
  });

  it('the ablation does not weaken the STRUCTURAL half: same-node writes are still refused', async () => {
    const base = hostedState();
    const a: MergeOp = { opId: 'a0', type: 'attr-set', psetNodeId: 'pset:wall', property: 'IsExternal', value: true };
    const b: MergeOp = { opId: 'b0', type: 'attr-set', psetNodeId: 'pset:wall', property: 'IsExternal', value: false };
    const outcome = await createCommutationCertificate({ base, opsA: [a], opsB: [b], spatialRule: 'disabled' });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('conflict');
  });
});

describe('wire format: node-hash-v0 is untouched', () => {
  it('hosting is NOT part of any node payload, so it cannot perturb a node hash', async () => {
    // node-hash-v0 is frozen at 1.0.0 with golden vectors (PR #1886); B4.2 is
    // allowed to change the OP MODEL, never the serialization. `hostId` lives
    // in the model state and in the convergence oracle only -- a v1 spec would
    // model it as an `IfcRelVoidsElement` relationship node, which is a spec
    // question, not a change this package may make unilaterally.
    const withHost = hostedState();
    const withoutHost: ModelState = {
      storeyIds: ['S0'],
      entities: new Map([
        [HOST_ID, entity('wall', 'IfcWall', tri(1, [0, 0, 0], 1))],
        [VOID_ID, entity('void', 'IfcOpeningElement', tri(2, [0.4, 0.4, 0], 0.2))],
      ]),
    };
    expect(await hashModelState(withHost)).toBe(await hashModelState(withoutHost));
    // ...but the logical states differ, and the convergence oracle says so.
    expect(canonicalStateBytes(withHost)).not.toBe(canonicalStateBytes(withoutHost));
  });

  it('a re-cut DOES change the host mesh hash, through the existing geometry-mesh encoding', async () => {
    const base = hostedState();
    const recut = applyOp(base, moveHost('a', 0.1));
    const movedOnly: ModelState = {
      storeyIds: ['S0'],
      entities: new Map([
        [HOST_ID, entity('wall', 'IfcWall', tri(1, [0.1, 0, 0], 1))],
        [VOID_ID, entity('void', 'IfcOpeningElement', tri(2, [0.4, 0.4, 0], 0.2), HOST_ID)],
      ]),
    };
    // Same placement, no recorded cut -> different mesh -> different root.
    expect(await hashModelState(recut)).not.toBe(await hashModelState(movedOnly));
  });
});

/* ------------------------------------------------------------------ */
/* Switchable semantics (G4 item 7)                                     */
/* ------------------------------------------------------------------ */

/**
 * The two couplings above are MODELLING CHOICES, not IFC. `IfcRelVoidsElement`
 * imposes no containment, and this repository derives the cut at load time
 * (`rust/geometry/src/void_index.rs` -> `rust/geometry/src/router/voids/`)
 * from the host's uncut `Body` rather than storing it. These tests pin the
 * switches that let the B4.2 headline be re-measured under the semantics the
 * production pipeline actually implements.
 */
describe('MergeSemantics: the couplings are switchable, and switching them is observable', () => {
  const DERIVED: MergeSemantics = { cuts: 'derived', containment: 'enforced' };
  const NO_CONTAINMENT: MergeSemantics = { cuts: 'lazy', containment: 'off' };
  const DERIVED_NO_CONTAINMENT: MergeSemantics = { cuts: 'derived', containment: 'off' };

  it('the default is the B4.2 semantics -- nothing published moves under it', () => {
    expect(DEFAULT_MERGE_SEMANTICS).toEqual({ cuts: 'lazy', containment: 'enforced' });
    const base = hostedState();
    expect(canonicalStateBytes(applyOp(base, moveHost('a', 0.1)))).toBe(
      canonicalStateBytes(applyOp(base, moveHost('a', 0.1), DEFAULT_MERGE_SEMANTICS)),
    );
  });

  it('LAZY cuts: a host move then an opening move does NOT commute (the B4.2 divergence)', () => {
    const base = hostedState();
    const host = moveHost('a', 0.1, 0.1);
    const opening = moveOpening('b', 0.5, 0.5);
    const ab = canonicalStateBytes(applyOp(applyOp(base, host), opening));
    const ba = canonicalStateBytes(applyOp(applyOp(base, opening), host));
    expect(ab).not.toBe(ba);
  });

  it('DERIVED cuts: the same pair commutes -- the divergence was the stored cut', () => {
    // The whole of the "6 divergences" mechanism, in one case. Nothing about
    // the ops changed; only whether the cut is a record or a function of the
    // current state.
    const base = hostedState();
    const host = moveHost('a', 0.1, 0.1);
    const opening = moveOpening('b', 0.5, 0.5);
    const ab = canonicalStateBytes(applyOp(applyOp(base, host, DERIVED), opening, DERIVED));
    const ba = canonicalStateBytes(applyOp(applyOp(base, opening, DERIVED), host, DERIVED));
    expect(ab).toBe(ba);
    expect(attemptBothOrders(base, [host], [opening], DERIVED).status).toBe('converged');
    expect(attemptBothOrders(base, [host], [opening]).status).toBe('diverged');
  });

  it('DERIVED cuts materialize the cut without any op touching the host', () => {
    // Under lazy semantics, moving the opening leaves the host's mesh alone;
    // under derived semantics the host's cut follows the opening, because it
    // is not a record of anything.
    const base = hostedState();
    const opening = moveOpening('b', 0.5, 0.5);
    const lazyHostMesh = applyOp(base, opening).entities.get(HOST_ID)!.meshes.get(HOST_MESH)!;
    const derivedHostMesh = applyOp(base, opening, DERIVED).entities.get(HOST_ID)!.meshes.get(HOST_MESH)!;
    expect(lazyHostMesh.positions.length).toBe(9);
    expect(derivedHostMesh.positions.length).toBeGreaterThan(9);
    // ...and it is idempotent: re-deriving reproduces the same bytes.
    const twice = applyOp(applyOp(base, opening, DERIVED), moveOpening('c', 0.5, 0.5), DERIVED);
    expect(canonicalStateBytes(twice)).toBe(canonicalStateBytes(applyOp(base, opening, DERIVED)));
  });

  it('containment OFF: an opening may leave its host, as IfcRelVoidsElement permits', () => {
    const base = hostedState();
    expect(() => applyOp(base, moveOpening('b', 0.9, 0.4))).toThrow(SpatialRejectionError);
    const escaped = applyOp(base, moveOpening('b', 0.9, 0.4), NO_CONTAINMENT);
    expect(stripVoidMarkers(escaped.entities.get(VOID_ID)!.meshes.get(VOID_MESH)!).origin).toEqual([0.9, 0.4, 0]);
    // Same for the host side.
    expect(() => applyOp(base, moveHost('a', 0.5))).toThrow(SpatialRejectionError);
    expect(applyOp(base, moveHost('a', 0.5), NO_CONTAINMENT)).toBeTruthy();
  });

  it('containment OFF alone converts a rejection into a DIVERGENCE, it does not remove the conflict', () => {
    // The reason the mechanism decomposition is not a partition: with the cut
    // still stored, the pair that used to fail to apply now applies in both
    // orders and produces different bytes instead.
    const base = hostedState();
    const host = moveHost('a', 0.5);
    const opening = moveOpening('b', 0.5, 0.5);
    expect(attemptBothOrders(base, [host], [opening]).status).toBe('apply-failed');
    expect(attemptBothOrders(base, [host], [opening], NO_CONTAINMENT).status).toBe('diverged');
    // Both switches together: it finally commutes.
    expect(attemptBothOrders(base, [host], [opening], DERIVED_NO_CONTAINMENT).status).toBe('converged');
  });

  it('a certificate issued under a variant re-verifies only under the same variant', async () => {
    // The mode is not recorded in the artifact, deliberately (same reason as
    // spatialRule), so a verifier that assumes the default must reject.
    const base = hostedState();
    const host = moveHost('a', 0.1, 0.1);
    const opening = moveOpening('b', 0.5, 0.5);
    const outcome = await createCommutationCertificate({
      base,
      opsA: [host],
      opsB: [opening],
      spatialRule: 'disabled',
      semantics: DERIVED,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const sameMode = await verifyCommutationCertificate(outcome.certificate, base, [host], [opening], {
      spatialRule: 'disabled',
      semantics: DERIVED,
    });
    expect(sameMode.ok).toBe(true);
    const defaultMode = await verifyCommutationCertificate(outcome.certificate, base, [host], [opening], {
      spatialRule: 'disabled',
    });
    expect(defaultMode.ok).toBe(false);
  });
});
