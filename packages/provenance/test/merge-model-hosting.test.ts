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
import { attemptBothOrders, createCommutationCertificate } from '../src/commutation.js';
import type { GeometryMeshPayload } from '../src/node-hash.js';
import {
  applyOp,
  buildStateDag,
  canonicalStateBytes,
  computeMergeOpFootprint,
  hashModelState,
  OpApplicationError,
  SpatialRejectionError,
  stripVoidMarkers,
  type EntityState,
  type MergeOp,
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
