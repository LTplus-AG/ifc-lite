/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Convergence property test (spec §18 §9.1).
 *
 * Run a randomized trace of concurrent edits across N peers. After every
 * burst, sync all peers via Y.applyUpdate and assert their JSON snapshots
 * are identical.
 *
 * Seeded so failures are reproducible.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabDoc, entitiesMap } from '../src/doc/schema.js';
import {
  addClassification,
  addMaterial,
  createEntity,
  deleteEntity,
  entityToJSON,
  setAttribute,
  setChild,
  setPropertyValue,
} from '../src/doc/entity.js';
import { createConflictDetector, type ConflictEvent } from '../src/conflicts/detector.js';

const PEERS = 3;
const ROUNDS = 30;
const ENTITIES_PER_ROUND = 4;

function syncAll(docs: Y.Doc[]) {
  // Pairwise sync: encode each doc's update against every other doc's SV.
  for (let i = 0; i < docs.length; i++) {
    for (let j = 0; j < docs.length; j++) {
      if (i === j) continue;
      const update = Y.encodeStateAsUpdate(docs[i], Y.encodeStateVector(docs[j]));
      Y.applyUpdate(docs[j], update, `peer-${i}`);
    }
  }
}

/**
 * Tiny seedable PRNG (Mulberry32) so failures are reproducible. We don't
 * need cryptographic randomness — just deterministic test traces.
 */
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Canonical, deep-key-sorted JSON. Y.Map iteration order is insertion-
 * order *locally*, which means after a merge two peers can iterate the
 * same keys in different orders — perfectly valid for CRDT convergence,
 * but it makes JSON.stringify-based comparison flaky. We canonicalise
 * here so the test compares semantic equality.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = canonicalise(obj[k]);
    return sorted;
  }
  return value;
}

function snapshotJSON(doc: Y.Doc): string {
  const ents = entitiesMap(doc);
  const out: Record<string, unknown> = {};
  const keys = Array.from(ents.keys()).sort();
  for (const k of keys) {
    const e = ents.get(k);
    if (!e) continue;
    out[k] = canonicalise(entityToJSON(e as Y.Map<unknown>));
  }
  return JSON.stringify(out);
}

describe('property: random concurrent edits converge', () => {
  it.each([42, 1337, 0xc0ffee])('seed=%i', (seed) => {
    const rand = mulberry32(seed);
    const docs = Array.from({ length: PEERS }, () => createCollabDoc());
    const events: ConflictEvent[][] = docs.map(() => []);
    docs.forEach((d, i) => createConflictDetector(d, { windowMs: 60_000 }).onConflict((e) => events[i].push(e)));

    // Seed: each peer starts with the same five entities.
    docs.forEach((d) => {
      for (let i = 0; i < 5; i++) {
        d.transact(() => createEntity(d, `e${i}`, { ifcClass: 'IfcWall' }));
      }
    });
    syncAll(docs);
    // The seed itself is a legitimate same-path concurrent create (every
    // peer independently creates e0..e4) — that's #4241's new signal
    // firing correctly, not noise. Clear it here so the assertion below
    // is about the randomized *editing* rounds, not the seed.
    events.forEach((e) => (e.length = 0));

    for (let round = 0; round < ROUNDS; round++) {
      docs.forEach((doc, peerIdx) => {
        for (let i = 0; i < ENTITIES_PER_ROUND; i++) {
          const path = `e${Math.floor(rand() * 5)}`;
          const op = Math.floor(rand() * 6);
          doc.transact(() => {
            switch (op) {
              case 0:
                setAttribute(doc, path, 'Name', `peer-${peerIdx}-r${round}-${i}`);
                break;
              case 1:
                setAttribute(doc, path, 'Description', `desc-${peerIdx}-${i}`);
                break;
              case 2:
                setPropertyValue(doc, path, 'Pset_WallCommon', 'FireRating', {
                  type: 'IfcLabel',
                  value: `EI${Math.floor(rand() * 4) * 30}`,
                });
                break;
              case 3: {
                const cousin = `e${Math.floor(rand() * 5)}`;
                if (cousin !== path) {
                  setChild(doc, path, `slot-${i}`, cousin);
                }
                break;
              }
              case 4:
                addClassification(doc, path, {
                  system: 'Uniclass',
                  code: `Pr_${Math.floor(rand() * 1000)}`,
                });
                break;
              case 5:
                addMaterial(doc, path, {
                  materialId: `mat-${peerIdx}-${i}`,
                  thickness: rand(),
                });
                break;
            }
          });
        }
      });
      syncAll(docs);
    }

    // All snapshots must be identical.
    const ref = snapshotJSON(docs[0]);
    docs.slice(1).forEach((d, idx) => {
      expect(snapshotJSON(d), `peer ${idx + 1} diverged from peer 0`).toBe(ref);
    });

    // Survival, not just agreement (#4241): this randomized trace never
    // creates at a colliding path after the seed (every round mutates
    // one of the five already-shared entities), so ordinary concurrent
    // editing across 30 rounds / 3 peers must never raise a false
    // `concurrent-create`. If it does, either the fixture grew a
    // same-path create the assertion isn't accounting for, or the
    // detector regressed into flagging non-colliding writes.
    for (const peerEvents of events) {
      for (const e of peerEvents) {
        expect(e.kind, `unexpected ${e.kind} conflict at ${e.path}`).not.toBe('concurrent-create');
      }
    }
  });

  it('survives concurrent deletes', () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    a.transact(() => createEntity(a, 'wall'));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    a.transact(() => deleteEntity(a, 'wall'));
    b.transact(() => setAttribute(b, 'wall', 'Name', 'edited'));

    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));

    expect(snapshotJSON(a)).toBe(snapshotJSON(b));
  });

  it('a same-path concurrent create is visible, not just agreed on (#4241)', () => {
    // Before #4241, this scenario passed the suite's convergence checks
    // (both peers agree on the same final entity) while an entire
    // peer's entity — class, attributes, everything — vanished with no
    // signal anywhere. Agreement alone can't distinguish "both peers
    // correctly merged" from "the CRDT quietly discarded one side and
    // everyone agrees on what's left." This test asserts the write's
    // disappearance is actually observable via the conflict detector.
    const a = createCollabDoc();
    const b = createCollabDoc();
    const aEvents: ConflictEvent[] = [];
    const bEvents: ConflictEvent[] = [];
    createConflictDetector(a, { windowMs: 60_000 }).onConflict((e) => aEvents.push(e));
    createConflictDetector(b, { windowMs: 60_000 }).onConflict((e) => bEvents.push(e));

    a.transact(() => createEntity(a, 'wall-7', { ifcClass: 'IfcWall' }));
    a.transact(() => setAttribute(a, 'wall-7', 'Name', 'Wall from Alice'));

    b.transact(() => createEntity(b, 'wall-7', { ifcClass: 'IfcColumn' }));
    b.transact(() => setAttribute(b, 'wall-7', 'Name', 'Column from Bob'));

    const aSv = Y.encodeStateVector(a);
    const bSv = Y.encodeStateVector(b);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, bSv));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, aSv));

    // Agreement still holds — this is correct CRDT behaviour, unchanged.
    expect(snapshotJSON(a)).toBe(snapshotJSON(b));

    // But it is no longer silent: both peers saw the collision.
    expect(aEvents.some((e) => e.kind === 'concurrent-create' && e.path === 'wall-7')).toBe(true);
    expect(bEvents.some((e) => e.kind === 'concurrent-create' && e.path === 'wall-7')).toBe(true);
  });
});
