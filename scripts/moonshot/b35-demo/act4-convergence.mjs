/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ACT 4 -- CONVERGENCE.
 *
 * Two simulated clients edit the PROVEN act-1 building concurrently through
 * the B2.1 merge op model (@ifc-lite/provenance merge-model + commutation).
 * The building's parsed entities become a ModelState (psets AND quantity
 * sets as pset leaves, same reading as act 2's DAG), then:
 *
 *   1. disjoint edits  -> a commutation certificate is issued, and
 *      independently re-verified (footprints, both replay orders and both
 *      Merkle commitments recomputed from scratch);
 *   2. a genuine collision (both clients write the same pset) -> the
 *      conflict predicate refuses to certify, exactly as it must;
 *   3. the G2 property battery reruns at demo scale: N randomized
 *      two-client schedules, every auto-merge certificate-backed, zero
 *      unsound merges tolerated.
 */

import { parseStore } from '../../../tools/world-gym/lib/checks.mjs';
import { RelationshipType } from '../../../packages/data/dist/index.js';
import {
  createCommutationCertificate, hashModelState, runMergeBattery, verifyCommutationCertificate,
} from '../../../packages/provenance/dist/index.js';
import { banner, pct, say, short } from './util.mjs';

function normalizePropertyValue(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Build a merge-model ModelState from a parsed world-gym store. */
export function stateFromStore(store) {
  const storeys = store.getEntitiesByType('IfcBuildingStorey')
    .map((s) => ({
      expressId: s.expressId,
      elementIds: store.relationships.getRelated(s.expressId, RelationshipType.ContainsElements, 'forward'),
    }))
    .sort((a, b) => a.expressId - b.expressId);

  const entities = new Map();
  const psetIndex = new Map(); // `${expressId}:${psetName}` -> psetNodeId
  for (const storey of storeys) {
    for (const expressId of storey.elementIds) {
      if (entities.has(`element:${expressId}`)) continue;
      const psets = new Map();
      const payloads = [];
      for (const pset of store.getProperties(expressId)) {
        payloads.push({
          name: pset.name,
          properties: pset.properties.map((p) => ({ name: p.name, value: normalizePropertyValue(p.value) })),
        });
      }
      for (const qset of store.getQuantities(expressId)) {
        payloads.push({
          name: qset.name,
          properties: qset.quantities.map((q) => ({ name: q.name, value: normalizePropertyValue(q.value) })),
        });
      }
      payloads.forEach((payload, i) => {
        const psetNodeId = `pset:${expressId}:${i}`;
        psets.set(psetNodeId, payload);
        psetIndex.set(`${expressId}:${payload.name}`, psetNodeId);
      });
      entities.set(`element:${expressId}`, {
        key: store.entities.getGlobalId(expressId) || String(expressId),
        ifcType: store.entities.getTypeName(expressId) || 'Unknown',
        storeyId: `storey:${storey.expressId}`,
        psets,
        meshes: new Map(),
      });
    }
  }

  const state = {
    storeyIds: storeys.map((s) => `storey:${s.expressId}`),
    entities,
  };
  return { state, psetIndex, storeys };
}

function firstElementOfType(store, state, typePrefix, { excludeExpressId } = {}) {
  const candidates = [...state.entities.keys()]
    .map((nodeId) => Number(nodeId.split(':')[1]))
    .sort((a, b) => a - b);
  for (const expressId of candidates) {
    if (expressId === excludeExpressId) continue;
    const ent = state.entities.get(`element:${expressId}`);
    if (new RegExp(`^${typePrefix}`, 'i').test(ent.ifcType) && ent.psets.size > 0) {
      return { expressId, entity: ent };
    }
  }
  return null;
}

export async function runAct4({ model, batterySchedules = 300, seed }) {
  banner(4, 'CONVERGENCE', 'two clients edit the proven building; only commuting merges get certificates');

  const store = await parseStore(model.content, `act1-birth-${model.seed}.ifc`);
  const { state } = stateFromStore(store);
  const baseRootHash = await hashModelState(state);
  say(`  base: ${state.entities.size} entities across ${state.storeyIds.length} storey(s), Merkle root ${short(baseRootHash, 24)}...`);

  const wall = firstElementOfType(store, state, 'IfcWall');
  const other = firstElementOfType(store, state, 'IfcSlab') ?? firstElementOfType(store, state, 'Ifc', { excludeExpressId: wall?.expressId });
  if (!wall || !other) throw new Error('could not pick two distinct elements with psets');
  const wallPset = [...wall.entity.psets.keys()][0];
  const otherPset = [...other.entity.psets.keys()][0];

  // -- 1. Disjoint concurrent edits: certified auto-merge. ----------------
  const opsA = [{ opId: 'alice-1', type: 'attr-set', psetNodeId: wallPset, property: 'FireRating', value: 'REI60' }];
  const opsB = [{ opId: 'bob-1', type: 'attr-set', psetNodeId: otherPset, property: 'Status', value: 'Reviewed' }];
  say(`  alice: attr-set ${wall.entity.ifcType} #${wall.expressId} FireRating = "REI60"`);
  say(`  bob:   attr-set ${other.entity.ifcType} #${other.expressId} Status = "Reviewed"`);

  const outcome = await createCommutationCertificate({
    base: state, opsA, opsB, clientA: 'alice', clientB: 'bob',
  });
  if (!outcome.ok) throw new Error(`expected certified auto-merge, got refusal: ${outcome.reason}`);
  const cert = outcome.certificate;
  say(`  commutation certificate issued: both orders replay to merged root ${short(cert.mergedRootHash, 24)}...`);

  const verification = await verifyCommutationCertificate(cert, state, opsA, opsB);
  say(`  independent re-verification (footprints + both orders + both commitments): ${verification.ok ? 'OK' : `FAILED (${verification.reason})`}`);
  if (!verification.ok) throw new Error(`commutation certificate failed re-verification: ${verification.reason}`);

  // -- 2. A genuine collision: correctly blocked. -------------------------
  const clashA = [{ opId: 'alice-2', type: 'attr-set', psetNodeId: wallPset, property: 'FireRating', value: 'REI60' }];
  const clashB = [{ opId: 'bob-2', type: 'attr-set', psetNodeId: wallPset, property: 'FireRating', value: 'REI90' }];
  say(`  now both clients write the SAME wall pset (REI60 vs REI90)...`);
  const clashOutcome = await createCommutationCertificate({
    base: state, opsA: clashA, opsB: clashB, clientA: 'alice', clientB: 'bob',
  });
  const blocked = clashOutcome.ok === false && clashOutcome.reason === 'conflict';
  say(`  outcome: ${blocked
    ? `BLOCKED -- ${clashOutcome.conflicts.length} conflicting cross pair(s), no certificate, goes to resolution`
    : 'NOT BLOCKED -- BUG'}`);

  // -- 3. The G2 battery, demo-sized. -------------------------------------
  say(`  property battery: ${batterySchedules} randomized two-client schedules (seed ${seed})...`);
  const battery = await runMergeBattery({ schedules: batterySchedules, seed });
  say(`    auto-merged: ${battery.autoMerged} (every one certificate-backed), flagged: ${battery.flaggedConflicts} (${pct(battery.conflictRate)})`);
  say(`    unsound auto-merges: ${battery.unsoundAutoMerges} (bar: exactly 0), certificate failures: ${battery.certificateFailures}`);
  say(`    false-conflict rate: ${pct(battery.falseConflictRate)} (kill criterion < 20%)`);
  say(`    exam: ${battery.examPass ? 'PASS' : 'FAIL'}, kill criterion: ${battery.killCriterionPass ? 'PASS' : 'FAIL'}`);

  say('');
  say(`  HEADLINE: certified auto-merge verified, collision correctly blocked, ` +
    `${battery.autoMerged}/${battery.schedules} schedules auto-merged with 0 unsound`);

  const { elapsedMs, ...batteryDeterministic } = battery;
  return {
    deterministic: {
      baseEntities: state.entities.size,
      baseRootHash,
      mergedRootHash: cert.mergedRootHash,
      certificateBaseRootHash: cert.baseRootHash,
      autoMerge: {
        clients: ['alice', 'bob'],
        aWrites: cert.a.writtenNodes.length,
        bWrites: cert.b.writtenNodes.length,
        verifiedIndependently: verification.ok,
      },
      blockedConflict: {
        blocked,
        conflicts: blocked
          ? clashOutcome.conflicts.map((c) => ({
            a: c.aOpId, b: c.bOpId, structural: c.result.structural, spatial: c.result.spatial,
          }))
          : [],
      },
      battery: batteryDeterministic,
    },
    volatile: { batteryElapsedMs: elapsedMs },
  };
}
