/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint suppressions and test suites in a three-way merge. Both are sidecar
 * records with a natural key: a suppression is keyed by node and rule, a
 * test case by its id. Per key, the side that changed it relative to the
 * base wins (theirs when both did, like a reorder); an unchanged key keeps
 * the base. They never raise content conflicts.
 */

import type { Suppression, StudioDocument } from '../document/types.js';
import { canonical } from '../match/cascade.js';
import type { PrimitiveOp } from '../ops/types.js';
import { applyPrimitive } from '../reducer/apply.js';
import { findTestCase } from '../reducer/test-ops.js';
import type { TestCase } from '../testing/types.js';
import { deriveId, type Uuid } from '../uuid.js';

interface SuppressionSite {
  nodeId: Uuid;
  suppression: Suppression;
}

interface CaseSite {
  specId: Uuid;
  testCase: TestCase;
}

function suppressions(doc: StudioDocument): Map<string, SuppressionSite> {
  const out = new Map<string, SuppressionSite>();
  for (const [nodeId, list] of Object.entries(doc.meta.suppressions)) {
    for (const suppression of list) out.set(`${nodeId}\u0000${suppression.rule}`, { nodeId, suppression });
  }
  return out;
}

function cases(doc: StudioDocument): Map<Uuid, CaseSite> {
  const out = new Map<Uuid, CaseSite>();
  for (const [specId, suite] of Object.entries(doc.meta.tests)) for (const testCase of suite.cases) out.set(testCase.id, { specId, testCase });
  return out;
}

/** The value a key takes: theirs if theirs changed it, else ours. */
function pick<T>(b: T | undefined, o: T | undefined, t: T | undefined): T | undefined {
  return canonical(t ?? null) !== canonical(b ?? null) ? t : o;
}

/** Ops that bring both sides' suppression and test-suite changes into `merged` (which carries the base records). */
export function sidecarMergeOps(base: StudioDocument, ours: StudioDocument, theirs: StudioDocument, merged: StudioDocument, seed: string): PrimitiveOp[] {
  const ops: PrimitiveOp[] = [];
  let doc = merged;
  const push = <K extends PrimitiveOp['kind']>(kind: K, payload: Extract<PrimitiveOp, { kind: K }>['payload']) => {
    const op = { kind, opId: deriveId(seed, `sidecar:${ops.length}`), payload } as PrimitiveOp;
    doc = applyPrimitive(doc, op).doc;
    ops.push(op);
  };

  const [bs, os, ts] = [suppressions(base), suppressions(ours), suppressions(theirs)];
  for (const key of new Set([...bs.keys(), ...os.keys(), ...ts.keys()])) {
    const want = pick(bs.get(key), os.get(key), ts.get(key));
    const have = suppressions(doc).get(key);
    if (canonical(want ?? null) === canonical(have ?? null)) continue;
    if (want) push('meta.suppress', { nodeId: want.nodeId, suppression: want.suppression });
    else if (have) push('meta.unsuppress', { nodeId: have.nodeId, rule: have.suppression.rule });
  }

  const [bc, oc, tc] = [cases(base), cases(ours), cases(theirs)];
  for (const id of new Set([...bc.keys(), ...oc.keys(), ...tc.keys()])) {
    const want = pick(bc.get(id), oc.get(id), tc.get(id));
    const have = findTestCase(doc, id);
    if (canonical(want ?? null) === canonical(have ? { specId: have.specId, testCase: have.testCase } : null)) continue;
    if (have) push('meta.test.remove', { testId: id });
    if (want) {
      // Keep the case's place when it stays in its suite; otherwise append. Suites outlive their specification.
      const length = doc.meta.tests[want.specId]?.cases.length ?? 0;
      const index = have && have.specId === want.specId ? Math.min(have.index, length) : length;
      push('meta.test.restore', { specId: want.specId, index, testCase: want.testCase });
    }
  }
  return ops;
}
