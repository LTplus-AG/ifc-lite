/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The grounding gate (§5, ADR-003): `checkOps(ops, doc, ctx)`.
 *
 * Runs before `apply`. Ops are checked in order against the document as
 * the PRECEDING accepted ops leave it (so a batch may add a spec and then
 * facets to it). A refused op is not simulated; later ops are still
 * checked so one call reports every problem. Compound ops are checked
 * through their expansion.
 *
 * Per op: schema shape (GATE-OP-001) → payload rules → simulated apply
 * (reducer refusals carry their gate code) → value well-formedness and
 * structure of the touched facets → grounding of the touched literal
 * names for every IFC version of the spec.
 *
 * Undo and redo replay exact inverses of accepted ops and do not need to
 * pass the gate again.
 */

import type { IDSFacet } from '@ifc-lite/ids';
import { getField, type FacetFieldName } from '../document/fields.js';
import { locateFacet } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import { expandCompound } from '../compound/expand.js';
import { DraftError } from '../ops/draft.js';
import { validateOp } from '../ops/schema.js';
import type { CompoundOp, PrimitiveOp, StudioOp } from '../ops/types.js';
import { applyPrimitive } from '../reducer/apply.js';
import { itemAt, OpApplyError } from '../reducer/edit.js';
import type { Uuid } from '../uuid.js';
import type { GateContext } from './context.js';
import { groundEntityFields, specVersions, type FieldScope } from './grounding.js';
import { groundPropertyFields } from './grounding-pset.js';
import { checkFacetStructure, checkOpPayload, groundingTargets, structureTargets } from './structural.js';
import type { GateCode, GateIssue, GateResult } from './types.js';
import { checkConstraint } from './values.js';

interface Collector {
  issues: GateIssue[];
  opIndex: number;
  opId?: Uuid;
  base: string;
}

function push(c: Collector, issue: Omit<GateIssue, 'ok' | 'opIndex' | 'opId' | 'candidates'> & Partial<Pick<GateIssue, 'candidates'>>): void {
  c.issues.push({ ok: false, opIndex: c.opIndex, ...(c.opId ? { opId: c.opId } : {}), candidates: [], ...issue });
}

function refusal(err: unknown): { code: GateCode; message: string } | undefined {
  if (err instanceof OpApplyError) return { code: err.code as GateCode, message: err.message };
  if (err instanceof DraftError) return { code: err.code, message: err.message };
  return undefined;
}

/** Well-formedness, structure and grounding of the facets an applied op touched. */
function checkAfter(c: Collector, op: PrimitiveOp, before: StudioDocument, after: StudioDocument, ctx: GateContext): void {
  for (const facetId of structureTargets(op)) {
    const loc = locateFacet(after, facetId);
    if (!loc) continue;
    const item = itemAt(after, loc);
    for (const p of checkFacetStructure(item.facet, item.requirement)) push(c, { code: p.code, message: p.message, path: c.base + p.at, facetId });
  }
  const specOfBefore = (id: Uuid) => locateFacet(before, id)?.specId;
  for (const target of groundingTargets(op, after, specOfBefore)) {
    const loc = locateFacet(after, target.facetId);
    if (!loc) continue;
    const spec = after.ids.specifications[loc.specIndex];
    const facet: IDSFacet = itemAt(after, loc).facet;
    for (const field of new Set<FacetFieldName>(target.fields)) {
      const constraint = getField(facet, field);
      if (!constraint) continue;
      const path = c.base + target.at(field);
      for (const p of checkConstraint(constraint)) push(c, { code: p.code, message: `${field}: ${p.message}`, path, facetId: target.facetId, field });
      const scope: FieldScope = { ctx, spec, versions: specVersions(spec), facet, field, customPsets: after.meta.custom.psets };
      for (const g of [...groundEntityFields(scope), ...groundPropertyFields(scope)]) {
        push(c, { ...g, path, facetId: target.facetId, field });
      }
    }
  }
}

function checkPrimitive(c: Collector, op: PrimitiveOp, doc: StudioDocument, ctx: GateContext): StudioDocument | undefined {
  const before = c.issues.length;
  for (const p of checkOpPayload(op)) push(c, { code: p.code, message: p.message, path: c.base + p.at });
  if (c.issues.length > before) return undefined;
  let next: StudioDocument;
  try {
    next = applyPrimitive(doc, op).doc;
  } catch (err) {
    const r = refusal(err);
    if (!r) throw err;
    push(c, { code: r.code, message: r.message, path: c.base });
    return undefined;
  }
  checkAfter(c, op, doc, next, ctx);
  return c.issues.length > before ? undefined : next;
}

function isCompound(op: StudioOp): op is CompoundOp {
  return op.kind.startsWith('bulk.');
}

/** Check a batch of untrusted ops against `doc`. Never throws on bad input. */
export function checkOps(ops: readonly unknown[], doc: StudioDocument, ctx: GateContext): GateResult {
  const issues: GateIssue[] = [];
  let current = doc;
  ops.forEach((raw, opIndex) => {
    const c: Collector = { issues, opIndex, base: `ops[${opIndex}]` };
    const valid = validateOp(raw);
    if (!valid.ok) {
      for (const e of valid.errors) push(c, { code: 'GATE-OP-001', message: e.message, path: c.base + e.path.slice(1) });
      return;
    }
    const op: StudioOp = valid.op;
    c.opId = op.opId;
    let primitives: PrimitiveOp[];
    if (isCompound(op)) {
      try {
        primitives = expandCompound(current, op);
      } catch (err) {
        const r = refusal(err);
        if (!r) throw err;
        push(c, { code: r.code, message: r.message, path: c.base });
        return;
      }
    } else {
      primitives = [op];
    }
    let working: StudioDocument | undefined = current;
    primitives.forEach((p, j) => {
      if (!working) return;
      const sub: Collector = { ...c, base: primitives.length > 1 || p !== op ? `${c.base}.expanded[${j}]` : c.base };
      working = checkPrimitive(sub, p, working, ctx);
    });
    if (working) current = working;
  });
  return { ok: issues.length === 0, issues };
}
