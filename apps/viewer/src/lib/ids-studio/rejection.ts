/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Remedies for a batch the gate refused: resubmit it with one of the gate's
 * ranked candidates in place of the offending literal, or (for an undeclared
 * custom property set) with a deliberate declaration in front. The result is
 * a NEW batch that goes through the gate again; nothing here bypasses it.
 */

import { uuidv7, type GateIssue, type StudioOp } from '@ifc-lite/ids-authoring';
import { declarePsetOp } from './ops';

/** `ops[2].payload.facet.baseName` → `[2, 'payload', 'facet', 'baseName']`. */
function parsePath(path: string): Array<string | number> | null {
  const match = /^ops\[(\d+)\]((?:\.[A-Za-z_$][\w$]*|\[\d+\])*)$/.exec(path);
  if (!match) return null;
  const rest = [...match[2].matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]/g)].map((m) => (m[1] ?? Number(m[2])));
  return [Number(match[1]), ...rest];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isRecord = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Fresh op ids: a resubmitted batch is a new batch. */
function renew(ops: readonly StudioOp[]): StudioOp[] {
  return ops.map((op) => ({ ...op, opId: uuidv7() }));
}

/**
 * The batch with `candidate` written where the issue points: into an
 * `equals` draft's value, or over a plain string. `null` when the issue does
 * not point at a literal (nothing sensible to substitute).
 */
export function withCandidate(ops: readonly StudioOp[], issue: GateIssue, candidate: string): StudioOp[] | null {
  const path = parsePath(issue.path);
  if (!path || path.length < 2) return null;
  const copy = structuredClone(ops) as unknown as Json[];
  let parent: Json = copy;
  for (const key of path.slice(0, -1)) {
    const next: Json | undefined = Array.isArray(parent) && typeof key === 'number' ? parent[key]
      : isRecord(parent) && typeof key === 'string' ? parent[key] : undefined;
    if (next === undefined) return null;
    parent = next;
  }
  const last = path[path.length - 1];
  const target: Json | undefined = Array.isArray(parent) && typeof last === 'number' ? parent[last]
    : isRecord(parent) && typeof last === 'string' ? parent[last] : undefined;
  if (isRecord(target) && target.kind === 'equals') target.value = candidate;
  else if (typeof target === 'string' && isRecord(parent) && typeof last === 'string') parent[last] = candidate;
  else return null;
  return renew(copy as unknown as StudioOp[]);
}

/** For GATE-CUST-001 (an undeclared custom set): declare it, then the same batch. */
export function withCustomDeclaration(ops: readonly StudioOp[], issue: GateIssue): StudioOp[] | null {
  if (issue.code !== 'GATE-CUST-001' || !issue.value) return null;
  return [declarePsetOp(issue.value), ...renew(ops)];
}
