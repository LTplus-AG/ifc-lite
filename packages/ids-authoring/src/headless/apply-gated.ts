/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one entry point through which a headless caller (an MCP client, an
 * SDK script, a Flow node) changes an IDS document: untrusted ops are
 * validated against the op JSON Schema (`validateOp`) and checked by the
 * grounding gate (`checkOps`) as a batch; only a batch that passes is
 * applied. A refused batch returns the gate's issues as data, each with
 * its path, message and ranked candidates, so the caller can correct the
 * names and retry. ADR-002/003: nothing else writes a document.
 */

import type { StudioDocument } from '../document/types.js';
import { checkOps } from '../gate/check.js';
import type { GateContext } from '../gate/context.js';
import type { GateIssue } from '../gate/types.js';
import { validateOp } from '../ops/schema.js';
import type { PrimitiveOp, StudioOp } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import type { Uuid } from '../uuid.js';

export type GatedApplyResult =
  | {
      ok: true;
      doc: StudioDocument;
      /** The primitive ops applied (compound ops expanded). */
      applied: PrimitiveOp[];
      /** Ops that undo the batch, in order. */
      inverses: PrimitiveOp[];
      /** Node ids created, changed, moved or removed. */
      touched: Uuid[];
    }
  | {
      ok: false;
      /** The input document, unchanged. */
      doc: StudioDocument;
      issues: GateIssue[];
    };

/** Validate, gate and apply `ops` (untrusted) to `doc`. Never applies part of a batch. */
export function applyOpsGated(doc: StudioDocument, ops: unknown, ctx: GateContext): GatedApplyResult {
  if (!Array.isArray(ops)) {
    const issue: GateIssue = { ok: false, code: 'GATE-OP-001', path: 'ops', message: 'ops must be an array of operations', candidates: [], opIndex: -1 };
    return { ok: false, doc, issues: [issue] };
  }
  const gate = checkOps(ops, doc, ctx);
  if (!gate.ok) return { ok: false, doc, issues: gate.issues };
  // The gate validated every op; re-validating here yields the typed value.
  const typed: StudioOp[] = ops.map((raw) => {
    const v = validateOp(raw);
    if (!v.ok) throw new Error('an op that passed the gate failed validation');
    return v.op;
  });
  const result = apply(doc, typed);
  return { ok: true, doc: result.doc, applied: result.expanded, inverses: result.inverses, touched: [...result.touched] };
}
