/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * commutation.ts (Bet B2.1): certificate creation for genuinely-independent
 * op sets, the typed conflict refusal, and a verifier that trusts nothing --
 * tampered commitments, mismatched op sets, and conflicting inputs must all
 * fail verification.
 */

import { describe, expect, it } from 'vitest';
import type { GeometryMeshPayload, PropertySetPayload } from '../src/node-hash.js';
import {
  attemptBothOrders,
  COMMUTATION_CERTIFICATE_VERSION,
  createCommutationCertificate,
  findCrossConflicts,
  verifyCommutationCertificate,
  type CommutationCertificate,
} from '../src/commutation.js';
import { canonicalStateBytes, hashModelState, type EntityState, type MergeOp, type ModelState } from '../src/merge-model.js';

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

function pset(): PropertySetPayload {
  return { name: 'Pset_Common', properties: [{ name: 'IsExternal', value: true }] };
}

function entity(tag: string, storeyId: string, origin: readonly [number, number, number]): EntityState {
  return {
    key: `GUID-${tag}`,
    ifcType: 'IfcWall',
    storeyId,
    psets: new Map([[`pset:${tag}`, pset()]]),
    meshes: new Map([[`mesh:${tag}`, mesh(1, origin)]]),
  };
}

function baseState(): ModelState {
  return {
    storeyIds: ['S0'],
    entities: new Map([
      ['element:a', entity('a', 'S0', [0, 0, 0])],
      ['element:b', entity('b', 'S0', [50, 50, 0])],
    ]),
  };
}

const editA: MergeOp = { opId: 'a0', type: 'attr-set', psetNodeId: 'pset:a', property: 'IsExternal', value: false };
const editB: MergeOp = { opId: 'b0', type: 'attr-set', psetNodeId: 'pset:b', property: 'FireRating', value: 'EI60' };
/** Same pset as editA -- structurally conflicts with it. */
const clashB: MergeOp = { opId: 'b1', type: 'attr-set', psetNodeId: 'pset:a', property: 'IsExternal', value: true };

describe('createCommutationCertificate', () => {
  it('certifies two independent op sets: both orders converge, commitments are real', async () => {
    const base = baseState();
    const outcome = await createCommutationCertificate({ base, opsA: [editA], opsB: [editB] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.certificate.version).toBe(COMMUTATION_CERTIFICATE_VERSION);
    expect(outcome.certificate.baseRootHash).toBe(await hashModelState(base));
    expect(outcome.certificate.mergedRootHash).toBe(await hashModelState(outcome.merged));
    expect(outcome.certificate.a.opIds).toEqual(['a0']);
    expect(outcome.certificate.a.writtenNodes).toEqual(['element:a', 'pset:a']);
    // The merged state is genuinely order-independent.
    const replay = attemptBothOrders(base, [editA], [editB]);
    expect(replay.status).toBe('converged');
    if (replay.status === 'converged') {
      expect(canonicalStateBytes(replay.merged)).toBe(canonicalStateBytes(outcome.merged));
    }
  });

  it('refuses with reason "conflict" when a cross pair collides, naming the pair', async () => {
    const base = baseState();
    const outcome = await createCommutationCertificate({ base, opsA: [editA], opsB: [clashB] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.reason !== 'conflict') {
      throw new Error(`expected conflict refusal, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.conflicts[0]).toMatchObject({ aOpId: 'a0', bOpId: 'b1' });
    expect(outcome.conflicts[0].result.structural).toBe(true);
  });

  it('spatially-colliding geometry edits on different elements are refused as conflict (epsilon rule)', async () => {
    const base = baseState();
    const geomA: MergeOp = { opId: 'a0', type: 'geometry-replace', meshNodeId: 'mesh:a', payload: mesh(1, [50, 50, 0]) };
    const geomB: MergeOp = { opId: 'b0', type: 'geometry-replace', meshNodeId: 'mesh:b', payload: mesh(1, [50.5, 50.5, 0]) };
    const outcome = await createCommutationCertificate({ base, opsA: [geomA], opsB: [geomB] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === 'conflict') {
      expect(outcome.conflicts[0].result.spatial).toBe(true);
    }
  });
});

describe('findCrossConflicts / attemptBothOrders (ground truth)', () => {
  it('remove vs edit of the same entity: flagged, and replay genuinely fails in one order', () => {
    const base = baseState();
    const remove: MergeOp = { opId: 'a0', type: 'entity-remove', entityNodeId: 'element:a' };
    expect(findCrossConflicts(base, [remove], [editA]).length).toBeGreaterThan(0);
    const truth = attemptBothOrders(base, [remove], [editA]);
    expect(truth.status).toBe('apply-failed');
  });

  it('same pset, same property, same value: flagged but converges -- a measurable false conflict', () => {
    const base = baseState();
    const sameA: MergeOp = { opId: 'a0', type: 'attr-set', psetNodeId: 'pset:a', property: 'Status', value: 'New' };
    const sameB: MergeOp = { opId: 'b0', type: 'attr-set', psetNodeId: 'pset:a', property: 'Status', value: 'New' };
    expect(findCrossConflicts(base, [sameA], [sameB]).length).toBeGreaterThan(0);
    expect(attemptBothOrders(base, [sameA], [sameB]).status).toBe('converged');
  });

  it('same pset, same property, DIFFERENT values: flagged and truly diverges', () => {
    const base = baseState();
    const setA: MergeOp = { opId: 'a0', type: 'attr-set', psetNodeId: 'pset:a', property: 'Status', value: 'New' };
    const setB: MergeOp = { opId: 'b0', type: 'attr-set', psetNodeId: 'pset:a', property: 'Status', value: 'Demolish' };
    expect(findCrossConflicts(base, [setA], [setB]).length).toBeGreaterThan(0);
    expect(attemptBothOrders(base, [setA], [setB]).status).toBe('diverged');
  });
});

describe('verifyCommutationCertificate', () => {
  async function goodCertificate(): Promise<{ base: ModelState; certificate: CommutationCertificate }> {
    const base = baseState();
    const outcome = await createCommutationCertificate({ base, opsA: [editA], opsB: [editB] });
    if (!outcome.ok) throw new Error('fixture certificate creation failed');
    return { base, certificate: outcome.certificate };
  }

  it('accepts an untampered certificate', async () => {
    const { base, certificate } = await goodCertificate();
    const result = await verifyCommutationCertificate(certificate, base, [editA], [editB]);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a tampered merged commitment', async () => {
    const { base, certificate } = await goodCertificate();
    const tampered = { ...certificate, mergedRootHash: 'sha256:' + '0'.repeat(64) };
    const result = await verifyCommutationCertificate(tampered, base, [editA], [editB]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('merged-root-mismatch');
  });

  it('rejects a tampered base commitment', async () => {
    const { base, certificate } = await goodCertificate();
    const tampered = { ...certificate, baseRootHash: 'sha256:' + 'f'.repeat(64) };
    const result = await verifyCommutationCertificate(tampered, base, [editA], [editB]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('base-root-mismatch');
  });

  it('rejects when the presented op sets are not the certified ones', async () => {
    const { base, certificate } = await goodCertificate();
    const otherB: MergeOp = { opId: 'b9', type: 'attr-set', psetNodeId: 'pset:b', property: 'Status', value: 'New' };
    const result = await verifyCommutationCertificate(certificate, base, [editA], [otherB]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('op-ids-mismatch');
  });

  it('rejects when the presented op sets actually conflict', async () => {
    const { base, certificate } = await goodCertificate();
    const tampered = {
      ...certificate,
      b: { ...certificate.b, opIds: ['b1'] },
    };
    const result = await verifyCommutationCertificate(tampered, base, [editA], [clashB]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('conflicting-op-sets');
  });

  it('rejects a wrong version tag', async () => {
    const { base, certificate } = await goodCertificate();
    const tampered = { ...certificate, version: 'commutation-v999' } as unknown as CommutationCertificate;
    const result = await verifyCommutationCertificate(tampered, base, [editA], [editB]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('version-mismatch');
  });

  it('rejects a tampered writtenNodes summary', async () => {
    const { base, certificate } = await goodCertificate();
    const tampered = { ...certificate, a: { ...certificate.a, writtenNodes: ['element:a'] } };
    const result = await verifyCommutationCertificate(tampered, base, [editA], [editB]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('written-nodes-mismatch');
  });

  it('verifies client attribution against caller-owned identities, not the certificate itself', async () => {
    const base = baseState();
    const outcome = await createCommutationCertificate({
      base,
      opsA: [editA],
      opsB: [editB],
      clientA: 'alice',
      clientB: 'bob',
    });
    if (!outcome.ok) throw new Error('fixture certificate creation failed');
    const { certificate } = outcome;

    // A tampered attribution must FAIL when the verifier supplies its own
    // expected identities -- previously the expectation was derived from the
    // certificate's own field, making the check a tautology.
    const tampered = { ...certificate, a: { ...certificate.a, client: 'mallory' } };
    const caught = await verifyCommutationCertificate(tampered, base, [editA], [editB], {
      expectedClientA: 'alice',
      expectedClientB: 'bob',
    });
    expect(caught.ok).toBe(false);
    if (!caught.ok) expect(caught.reason).toBe('client-mismatch');

    // The untampered certificate passes with the same expected identities.
    const genuine = await verifyCommutationCertificate(certificate, base, [editA], [editB], {
      expectedClientA: 'alice',
      expectedClientB: 'bob',
    });
    expect(genuine).toEqual({ ok: true });

    // Without caller-supplied identities the labels are unverifiable
    // metadata: verification still passes, and callers must not trust them.
    const unchecked = await verifyCommutationCertificate(tampered, base, [editA], [editB]);
    expect(unchecked).toEqual({ ok: true });
  });
});

/**
 * Regression guard for PR #1933, finding F3 of the pre-freeze adversarial
 * attack on node-hash-v0: a certificate verifying against a genuinely
 * different base. F3 is the end-to-end consequence of F1 and F2 (the missing
 * `RelatingStructure` / storey element node and the missing
 * `IfcRelVoidsElement` node, guarded in merge-model.test.ts and
 * merge-model-hosting.test.ts) -- it needs no separate producer fix and
 * closes when those two do.
 *
 * A certificate's only tie to the model it was issued for is `baseRootHash`,
 * so that root has to separate models that genuinely differ. These are the
 * end-to-end guards for that: a certificate issued over base B1 must be
 * REFUSED against a base B2 that differs only in a relationship -- which is
 * exactly the case a root that ignores storey/host bindings cannot see.
 */
describe('a certificate binds to the base it was issued for', () => {
  async function issueOver(base: ModelState) {
    const outcome = await createCommutationCertificate({ base, opsA: [editA], opsB: [editB] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`expected a certificate, got ${outcome.reason}`);
    return outcome.certificate;
  }

  async function expectRefused(certificate: CommutationCertificate, other: ModelState, self: ModelState) {
    // The two bases are genuinely different models.
    expect(canonicalStateBytes(other)).not.toBe(canonicalStateBytes(self));
    const cross = await verifyCommutationCertificate(certificate, other, [editA], [editB]);
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.reason).toBe('base-root-mismatch');
    // Control: it still verifies against its own base.
    expect(await verifyCommutationCertificate(certificate, self, [editA], [editB])).toEqual({ ok: true });
  }

  it('refuses a certificate issued over B1 against a B2 that differs only by storey containment', async () => {
    const b1: ModelState = {
      storeyIds: ['S0', 'S1'],
      entities: new Map([
        ['element:a', entity('a', 'S0', [0, 0, 0])],
        ['element:b', entity('b', 'S1', [50, 50, 0])],
      ]),
    };
    // Same elements, same bytes per element -- the two storeys swapped.
    const b2: ModelState = {
      storeyIds: ['S0', 'S1'],
      entities: new Map([
        ['element:a', entity('a', 'S1', [0, 0, 0])],
        ['element:b', entity('b', 'S0', [50, 50, 0])],
      ]),
    };
    await expectRefused(await issueOver(b1), b2, b1);
  });
});
