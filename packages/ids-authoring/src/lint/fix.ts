/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Quick-fix contract helpers.
 *
 * A quick fix is a labelled op batch. Its op ids (and any node ids it
 * mints) are derived deterministically from the rule code, the node and a
 * variant tag, so the same document always yields byte-identical
 * diagnostics; that keeps the engine cache and snapshot tests stable.
 *
 * `checkQuickFix` runs the batch through the grounding gate. Every fix the
 * catalogue emits passes the gate on the document it was computed for
 * (enforced by the rule tests).
 */

import type { StudioDocument } from '../document/types.js';
import { checkOps } from '../gate/check.js';
import type { GateContext } from '../gate/context.js';
import type { GateResult } from '../gate/types.js';
import type { PrimitiveOp, StudioOp } from '../ops/types.js';
import { deriveId, type Uuid } from '../uuid.js';
import type { QuickFix } from './types.js';

/** Deterministic id source for one fix. */
export function fixIds(code: string, nodeId: Uuid, variant = ''): () => Uuid {
  let n = 0;
  const seed = `lint|${code}|${nodeId}|${variant}`;
  return () => deriveId(seed, `#${n++}`);
}

/** A primitive op without its `opId` (distributes over the union). */
export type OpBody = PrimitiveOp extends infer O ? (O extends PrimitiveOp ? Omit<O, 'opId'> : never) : never;

/** Build a quick fix from op bodies; op ids are derived. */
export function quickFix(
  label: string,
  code: string,
  nodeId: Uuid,
  variant: string,
  bodies: readonly OpBody[],
): QuickFix {
  const next = fixIds(code, nodeId, `${variant}|ops`);
  const ops: StudioOp[] = bodies.map((b): PrimitiveOp => ({ ...b, opId: next() }));
  return { label, ops };
}

/** Check a quick fix against the document it was computed for. */
export function checkQuickFix(doc: StudioDocument, fix: QuickFix, gate: GateContext): GateResult {
  return checkOps(fix.ops, doc, gate);
}
