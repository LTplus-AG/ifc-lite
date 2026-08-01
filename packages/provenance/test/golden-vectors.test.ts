/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Golden wire-format vectors for node-hash-v0 (FROZEN 2026-07-25, spec
 * version node-hash-v0 / 1.0.0, docs/vision/spec/node-hash-v0.md).
 *
 * Regression suite for the freeze itself, landed by PR #1886 -- the PR whose
 * merge IS the freeze act. The ps-unicode vectors trace to findings F4/F5 of
 * the pre-freeze adversarial attack (NFC-normalised comparison, and rejecting
 * out-of-domain payloads rather than coercing them).
 *
 * Every vector in `test/golden/*.json` carries a payload and the hash the
 * frozen implementation produced for it at freeze time. This suite recomputes
 * every vector and byte-compares. Byte-for-byte pinning is exactly right here
 * (per AGENTS.md "Writing tests"): the byte layout IS the compatibility
 * contract — that is what "frozen" means.
 *
 * If a vector fails: the wire format changed. That is never fixed by
 * regenerating the fixtures. If the change is intentional it requires
 * node-hash-v1 — a new versioned spec file with a new magic/version byte and
 * a major version bump of @ifc-lite/provenance (see the FROZEN header block
 * in the spec).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeNodeHash, type NodeKind, type PayloadForKind } from '../src/index.js';

const FREEZE_POLICY =
  'node-hash-v0 wire format is FROZEN (1.0.0, 2026-07-25 — docs/vision/spec/node-hash-v0.md). ' +
  'A golden-vector mismatch means the wire format changed. If this change is intentional it ' +
  'requires node-hash-v1: a new versioned spec file plus a major version bump of ' +
  '@ifc-lite/provenance. Never "fix" this by regenerating the vectors under the v0 name.';

interface GoldenVector {
  id: string;
  description: string;
  kind: NodeKind;
  payload: unknown;
  expectedHash: string;
  /** This vector's hash must equal the referenced vector's (an invariance pair). */
  expectSameHashAs?: string;
  /** This vector's hash must differ from the referenced vector's (a sensitivity pair). */
  expectDifferentHashFrom?: string;
}

/** Fixture JSONs encode non-JSON numbers as `{"$num": "NaN" | "Infinity" |
 *  "-Infinity" | "-0"}`; everything else is plain JSON. */
function decodeSpecials(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeSpecials);
  if (v && typeof v === 'object') {
    const record = v as Record<string, unknown>;
    if (typeof record.$num === 'string' && Object.keys(record).length === 1) {
      switch (record.$num) {
        case 'NaN':
          return NaN;
        case 'Infinity':
          return Infinity;
        case '-Infinity':
          return -Infinity;
        case '-0':
          return -0;
        default:
          throw new Error(`golden fixture: unknown $num sentinel "${record.$num}"`);
      }
    }
    return Object.fromEntries(Object.entries(record).map(([k, x]) => [k, decodeSpecials(x)]));
  }
  return v;
}

function loadGolden(file: string): GoldenVector[] {
  const raw = readFileSync(new URL(`./golden/${file}`, import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { vectors: GoldenVector[] };
  return parsed.vectors.map((v) => ({ ...v, payload: decodeSpecials(v.payload) }));
}

const GOLDEN_FILES = [
  'geometry-mesh.json',
  'property-set.json',
  'relationship.json',
  'layer.json',
  'element.json',
  'merkle-chain.json',
] as const;

/** Pinned at freeze time (55), plus the two `ps-unicode-*-multi-prop` vectors
 *  added pre-merge for the sort/encode normalization split (see `compareUtf8`)
 *  — finding F4 of the pre-freeze adversarial attack on node-hash-v0,
 *  commissioned because a freeze makes bug-for-bug behaviour the contract.
 *  Both the attack and its fix landed in PR #1886, the freeze PR (see the
 *  `harden(provenance): close the NFC sort/encode split ... (F4/F5/F11)`
 *  commit for the full finding write-up). Adding coverage never changes the
 *  format — every one of the
 *  original 55 hashes is byte-identical — but REMOVING a vector is a hole in
 *  the frozen contract's coverage: restore it rather than lowering this count. */
const FROZEN_VECTOR_COUNT = 57;

const allVectors = GOLDEN_FILES.map((file) => ({ file, vectors: loadGolden(file) }));

describe('node-hash-v0 golden wire-format vectors (FROZEN)', () => {
  it(`covers the frozen vector set (${FROZEN_VECTOR_COUNT} vectors)`, () => {
    const total = allVectors.reduce((n, f) => n + f.vectors.length, 0);
    expect(total, FREEZE_POLICY).toBe(FROZEN_VECTOR_COUNT);
  });

  for (const { file, vectors } of allVectors) {
    describe(file, () => {
      const byId = new Map(vectors.map((v) => [v.id, v]));

      for (const vector of vectors) {
        it(`${vector.id}: ${vector.description}`, async () => {
          const actual = await computeNodeHash(
            vector.kind,
            vector.payload as PayloadForKind<NodeKind>,
          );
          expect(actual, `Vector "${vector.id}" drifted. ${FREEZE_POLICY}`).toBe(
            vector.expectedHash,
          );

          if (vector.expectSameHashAs !== undefined) {
            const other = byId.get(vector.expectSameHashAs);
            expect(other, `vector "${vector.id}" references missing pair "${vector.expectSameHashAs}"`).toBeDefined();
            expect(
              actual,
              `Invariance pair broken: "${vector.id}" must hash identically to ` +
                `"${vector.expectSameHashAs}". ${FREEZE_POLICY}`,
            ).toBe(other?.expectedHash);
          }

          if (vector.expectDifferentHashFrom !== undefined) {
            const other = byId.get(vector.expectDifferentHashFrom);
            expect(other, `vector "${vector.id}" references missing pair "${vector.expectDifferentHashFrom}"`).toBeDefined();
            expect(
              actual,
              `Sensitivity pair broken: "${vector.id}" must hash differently from ` +
                `"${vector.expectDifferentHashFrom}". ${FREEZE_POLICY}`,
            ).not.toBe(other?.expectedHash);
          }
        });
      }
    });
  }
});
