/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * merge-model.ts (Bet B2.1): op application semantics, canonical-bytes
 * order-insensitivity (the "deterministic kernel model" stand-in), Merkle
 * commitment behaviour, and footprint derivation per op kind -- including
 * the entity-add path that bypasses computeFootprint because its target ids
 * do not exist in the base DAG.
 */

import { describe, expect, it } from 'vitest';
import { computeNodeHash, type GeometryMeshPayload, type PropertySetPayload } from '../src/node-hash.js';
import { conflictPredicate } from '../src/footprint.js';
import {
  applyOp,
  applyOps,
  buildStateDag,
  canonicalStateBytes,
  computeMergeOpFootprint,
  hashModelState,
  MERGE_MODEL_ROOT_NODE_ID,
  OpApplicationError,
  type EntityInit,
  type EntityState,
  type MergeOp,
  type ModelState,
} from '../src/merge-model.js';

function mesh(expressId: number, origin: readonly [number, number, number]): GeometryMeshPayload {
  return {
    expressId,
    geometryClass: 0,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    origin,
  };
}

function wallPset(): PropertySetPayload {
  return { name: 'Pset_Common', properties: [{ name: 'IsExternal', value: true }] };
}

function entity(tag: string, storeyId: string, origin: readonly [number, number, number]): EntityState {
  return {
    key: `GUID-${tag}`,
    ifcType: 'IfcWall',
    storeyId,
    psets: new Map([[`pset:${tag}`, wallPset()]]),
    meshes: new Map([[`mesh:${tag}`, mesh(1, origin)]]),
  };
}

/** Two storeys, two elements: element:a on S0 at origin, element:b on S1 far away. */
function baseState(): ModelState {
  return {
    storeyIds: ['S0', 'S1'],
    entities: new Map([
      ['element:a', entity('a', 'S0', [0, 0, 0])],
      ['element:b', entity('b', 'S1', [50, 50, 3])],
    ]),
  };
}

function addInit(tag: string, storeyId: string, origin: readonly [number, number, number]): EntityInit {
  return {
    entityNodeId: `element:${tag}`,
    key: `GUID-${tag}`,
    ifcType: 'IfcDoor',
    storeyId,
    psets: [{ psetNodeId: `pset:${tag}`, payload: wallPset() }],
    meshes: [{ meshNodeId: `mesh:${tag}`, payload: mesh(9, origin) }],
  };
}

describe('applyOp', () => {
  it('entity-add inserts the entity; the input state is untouched', () => {
    const base = baseState();
    const next = applyOp(base, { opId: 'op', type: 'entity-add', entity: addInit('c', 'S0', [5, 5, 0]) });
    expect(next.entities.has('element:c')).toBe(true);
    expect(base.entities.has('element:c')).toBe(false);
  });

  it('entity-add throws on a duplicate entity id and on an unknown storey', () => {
    const base = baseState();
    expect(() => applyOp(base, { opId: 'op', type: 'entity-add', entity: addInit('a', 'S0', [0, 0, 0]) })).toThrow(
      OpApplicationError,
    );
    expect(() => applyOp(base, { opId: 'op', type: 'entity-add', entity: addInit('c', 'NOPE', [0, 0, 0]) })).toThrow(
      /storey/,
    );
  });

  it('entity-remove deletes; removing a missing entity throws', () => {
    const base = baseState();
    const next = applyOp(base, { opId: 'op', type: 'entity-remove', entityNodeId: 'element:a' });
    expect(next.entities.has('element:a')).toBe(false);
    expect(() => applyOp(next, { opId: 'op2', type: 'entity-remove', entityNodeId: 'element:a' })).toThrow(
      OpApplicationError,
    );
  });

  it('attr-set replaces an existing property and appends a new one', () => {
    const base = baseState();
    const s1 = applyOp(base, { opId: 'op', type: 'attr-set', psetNodeId: 'pset:a', property: 'IsExternal', value: false });
    const s2 = applyOp(s1, { opId: 'op2', type: 'attr-set', psetNodeId: 'pset:a', property: 'FireRating', value: 'EI60' });
    const pset = s2.entities.get('element:a')?.psets.get('pset:a');
    expect(pset?.properties.find((p) => p.name === 'IsExternal')?.value).toBe(false);
    expect(pset?.properties.find((p) => p.name === 'FireRating')?.value).toBe('EI60');
    // Original state untouched (payloads are values, never mutated in place).
    expect(base.entities.get('element:a')?.psets.get('pset:a')?.properties.find((p) => p.name === 'IsExternal')?.value).toBe(true);
  });

  it('attr-set / geometry-replace on unknown targets throw OpApplicationError', () => {
    const base = baseState();
    expect(() => applyOp(base, { opId: 'op', type: 'attr-set', psetNodeId: 'pset:zzz', property: 'X', value: 1 })).toThrow(
      OpApplicationError,
    );
    expect(() =>
      applyOp(base, { opId: 'op', type: 'geometry-replace', meshNodeId: 'mesh:zzz', payload: mesh(1, [0, 0, 0]) }),
    ).toThrow(OpApplicationError);
  });

  it('geometry-replace swaps the mesh payload', () => {
    const base = baseState();
    const next = applyOp(base, { opId: 'op', type: 'geometry-replace', meshNodeId: 'mesh:a', payload: mesh(1, [2, 2, 0]) });
    expect(next.entities.get('element:a')?.meshes.get('mesh:a')?.origin).toEqual([2, 2, 0]);
  });
});

describe('canonicalStateBytes: the byte-identical convergence oracle', () => {
  it('is insensitive to entity/pset insertion order (same logical state, same bytes)', () => {
    const forward = baseState();
    const reversed: ModelState = {
      storeyIds: ['S0', 'S1'],
      entities: new Map([
        ['element:b', entity('b', 'S1', [50, 50, 3])],
        ['element:a', entity('a', 'S0', [0, 0, 0])],
      ]),
    };
    expect(canonicalStateBytes(forward)).toBe(canonicalStateBytes(reversed));
  });

  it('two independent attr-sets commute to the same bytes in either order (hand-built commutation)', () => {
    const base = baseState();
    const opA: MergeOp = { opId: 'a0', type: 'attr-set', psetNodeId: 'pset:a', property: 'IsExternal', value: false };
    const opB: MergeOp = { opId: 'b0', type: 'attr-set', psetNodeId: 'pset:b', property: 'FireRating', value: 'EI90' };
    const ab = applyOps(base, [opA, opB]);
    const ba = applyOps(base, [opB, opA]);
    expect(canonicalStateBytes(ab)).toBe(canonicalStateBytes(ba));
  });

  it('differing property values produce differing bytes', () => {
    const base = baseState();
    const changed = applyOp(base, { opId: 'op', type: 'attr-set', psetNodeId: 'pset:a', property: 'IsExternal', value: false });
    expect(canonicalStateBytes(changed)).not.toBe(canonicalStateBytes(base));
  });
});

describe('buildStateDag / hashModelState', () => {
  it('builds the g1/g2 DAG shape: leaves -> element -> storey relationship -> root layer', async () => {
    const base = baseState();
    const dag = buildStateDag(base);
    expect(dag.getKind('element:a')).toBe('element');
    expect(dag.getKind('storey-rel:S0')).toBe('relationship');
    expect(dag.getKind(MERGE_MODEL_ROOT_NODE_ID)).toBe('layer');
    await dag.build();
    expect(dag.getHash(MERGE_MODEL_ROOT_NODE_ID)).toMatch(/^sha256:/);
  });

  it('root hash is deterministic across insertion orders and changes when a leaf changes', async () => {
    const forward = await hashModelState(baseState());
    const reversed: ModelState = {
      storeyIds: ['S0', 'S1'],
      entities: new Map([
        ['element:b', entity('b', 'S1', [50, 50, 3])],
        ['element:a', entity('a', 'S0', [0, 0, 0])],
      ]),
    };
    expect(await hashModelState(reversed)).toBe(forward);

    const edited = applyOp(baseState(), {
      opId: 'op',
      type: 'attr-set',
      psetNodeId: 'pset:a',
      property: 'IsExternal',
      value: false,
    });
    expect(await hashModelState(edited)).not.toBe(forward);
  });

  it('throws when an entity references an unknown storey', () => {
    const bad = baseState();
    (bad.entities.get('element:a') as EntityState).storeyId = 'S9';
    expect(() => buildStateDag(bad)).toThrow(/unknown storey/);
  });

  it('throws when an entity references an unknown host', () => {
    const bad = baseState();
    (bad.entities.get('element:a') as EntityState).hostId = 'element:ghost';
    expect(() => buildStateDag(bad)).toThrow(/unknown host/);
  });
});

/**
 * Regression guards for the three producer bindings the DAG must commit to.
 * Each of these passes ONLY because `buildStateDag` emits both EXPRESS roles
 * of `IfcRelContainedInSpatialStructure` and a real `IfcRelVoidsElement` node
 * per hosted element. Drop either and the model changes while the root hash
 * does not -- which is exactly a second preimage a certificate would accept.
 */
describe('the root hash binds the model relationships, not just its contents', () => {
  /** Re-parent an element with ORDINARY ops (no bespoke move op exists in
   *  this vocabulary): drop it, re-add it under a different storey. */
  function reparent(state: ModelState, tag: string, storeyId: string, origin: readonly [number, number, number]): ModelState {
    return applyOps(state, [
      { opId: `rm-${tag}`, type: 'entity-remove', entityNodeId: `element:${tag}` },
      { opId: `add-${tag}`, type: 'entity-add', entity: { ...addInit(tag, storeyId, origin), ifcType: 'IfcWall' } },
    ]);
  }

  it('moving one element from S0 to S1 changes the root', async () => {
    // Built with the SAME EntityInit the move re-adds, so the only difference
    // between the two states is the storey -- nothing else can move the root.
    const empty: ModelState = { storeyIds: ['S0', 'S1'], entities: new Map() };
    const base = applyOp(empty, {
      opId: 'add-a',
      type: 'entity-add',
      entity: { ...addInit('a', 'S0', [0, 0, 0]), ifcType: 'IfcWall' },
    });
    const moved = reparent(base, 'a', 'S1', [0, 0, 0]);

    // The states genuinely differ (the convergence oracle says so)...
    expect(canonicalStateBytes(moved)).not.toBe(canonicalStateBytes(base));
    // ...so the Merkle commitment must differ too. Without RelatingStructure
    // the two storey nodes merely SWAP hashes and the root layer, which sorts
    // its children, is byte-identical.
    expect(await hashModelState(moved)).not.toBe(await hashModelState(base));
  });

  it('two elements swapping storeys changes the root', async () => {
    const base: ModelState = {
      storeyIds: ['S0', 'S1'],
      entities: new Map([
        ['element:a', entity('a', 'S0', [0, 0, 0])],
        ['element:b', entity('b', 'S1', [50, 50, 3])],
      ]),
    };
    const swapped: ModelState = {
      storeyIds: ['S0', 'S1'],
      entities: new Map([
        ['element:a', entity('a', 'S1', [0, 0, 0])],
        ['element:b', entity('b', 'S0', [50, 50, 3])],
      ]),
    };
    expect(canonicalStateBytes(swapped)).not.toBe(canonicalStateBytes(base));
    expect(await hashModelState(swapped)).not.toBe(await hashModelState(base));
  });

  it('the storey containment node carries BOTH EXPRESS roles', async () => {
    const dag = buildStateDag(baseState());
    expect(dag.getKind('storey:S0')).toBe('element'); // the storey itself is a node
    await dag.build();
    // Pin the payload by re-deriving the node hash from it: RelatingStructure
    // (singular in IFC -- exactly one ref, the storey node) plus
    // RelatedElements. Any other role set produces a different hash.
    const expected = await computeNodeHash('relationship', {
      relType: 'IfcRelContainedInSpatialStructure',
      roles: [
        { roleName: 'RelatingStructure', refs: [dag.getHash('storey:S0') as string] },
        { roleName: 'RelatedElements', refs: [dag.getHash('element:a') as string] },
      ],
    });
    expect(dag.getHash('storey-rel:S0')).toBe(expected);
  });
});

describe('computeMergeOpFootprint', () => {
  it('attr-set: writtenNodes = {pset, element} (crux rule via computeFootprint), no region', () => {
    const base = baseState();
    const dag = buildStateDag(base);
    const fp = computeMergeOpFootprint(dag, base, {
      opId: 'op',
      type: 'attr-set',
      psetNodeId: 'pset:a',
      property: 'X',
      value: 1,
    });
    expect(fp.writtenNodes).toEqual(new Set(['pset:a', 'element:a']));
    expect(fp.region).toBeNull();
  });

  it('geometry-replace: region covers OLD union NEW mesh bounds', () => {
    const base = baseState();
    const dag = buildStateDag(base);
    const fp = computeMergeOpFootprint(dag, base, {
      opId: 'op',
      type: 'geometry-replace',
      meshNodeId: 'mesh:a',
      payload: mesh(1, [10, 10, 0]),
    });
    expect(fp.writtenNodes).toEqual(new Set(['mesh:a', 'element:a']));
    // Old triangle spans [0,1]^2 at z=0; new origin [10,10,0] spans [10,11]^2.
    expect(fp.region).toEqual({ min: [0, 0, 0], max: [11, 11, 0] });
  });

  it('entity-remove: writtenNodes includes the element node; region is the entity bounds', () => {
    const base = baseState();
    const dag = buildStateDag(base);
    const fp = computeMergeOpFootprint(dag, base, { opId: 'op', type: 'entity-remove', entityNodeId: 'element:a' });
    expect(fp.writtenNodes.has('element:a')).toBe(true);
    expect(fp.region).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
  });

  it('entity-add: writtenNodes are the op-supplied fresh ids (not in the base DAG)', () => {
    const base = baseState();
    const dag = buildStateDag(base);
    const fp = computeMergeOpFootprint(dag, base, { opId: 'op', type: 'entity-add', entity: addInit('c', 'S0', [5, 5, 0]) });
    expect(fp.writtenNodes).toEqual(new Set(['element:c', 'pset:c', 'mesh:c']));
    expect(fp.region).toEqual({ min: [5, 5, 0], max: [6, 6, 0] });
    expect(dag.has('element:c')).toBe(false);
  });

  it('two adds claiming the SAME id structurally conflict; distinct far-apart adds do not', () => {
    const base = baseState();
    const dag = buildStateDag(base);
    const fpShared1 = computeMergeOpFootprint(dag, base, { opId: 'a0', type: 'entity-add', entity: addInit('x', 'S0', [5, 5, 0]) });
    const fpShared2 = computeMergeOpFootprint(dag, base, { opId: 'b0', type: 'entity-add', entity: addInit('x', 'S1', [40, 40, 3]) });
    expect(conflictPredicate(fpShared1, fpShared2).structural).toBe(true);

    const fpFresh = computeMergeOpFootprint(dag, base, { opId: 'b1', type: 'entity-add', entity: addInit('y', 'S1', [40, 40, 3]) });
    expect(conflictPredicate(fpShared1, fpFresh).conflict).toBe(false);
  });

  it('remove vs a leaf edit of the same entity conflict (element node shared)', () => {
    const base = baseState();
    const dag = buildStateDag(base);
    const fpRemove = computeMergeOpFootprint(dag, base, { opId: 'a0', type: 'entity-remove', entityNodeId: 'element:a' });
    const fpEdit = computeMergeOpFootprint(dag, base, {
      opId: 'b0',
      type: 'attr-set',
      psetNodeId: 'pset:a',
      property: 'X',
      value: 1,
    });
    expect(conflictPredicate(fpRemove, fpEdit).structural).toBe(true);
  });
});
