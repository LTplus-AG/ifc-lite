/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reconcile two runs of one analysis across a comparison (#6921).
 *
 * Refuses, listing every specific incompatibility, unless the runs are of
 * the same kind, cover the comparison's base and head models respectively,
 * ran the same rules/specifications with the same settings and scope, and
 * are current: a run without an analysis stamp has unknown freshness and is
 * refused like a stale one. Compatible runs are reconciled into new / resolved /
 * persisting / changed / not evaluated; partial evidence never becomes
 * `resolved` (see the per-kind modules).
 */

import { clashIncompatibilities, reconcileClashRuns } from './run-reconcile-clash';
import { reconcileValidationRuns, validationIncompatibilities } from './run-reconcile-validation';
import type { CapturedRun, Incompatibility, ReconcileContext, ReconcileOutcome } from './run-reconcile-types';

export function runIncompatibilities(base: CapturedRun, head: CapturedRun, ctx: ReconcileContext | null): Incompatibility[] {
  if (!ctx) return [{ code: 'noComparison' }];
  if (base.kind !== head.kind) return [{ code: 'kindDiffers', detail: `${base.kind} / ${head.kind}` }];
  const out = base.kind === 'clash' && head.kind === 'clash'
    ? clashIncompatibilities(base, head, ctx)
    : base.kind === 'validation' && head.kind === 'validation' ? validationIncompatibilities(base, head, ctx) : [];
  const sides = (pick: (run: CapturedRun) => boolean): Array<'base' | 'head'> =>
    (['base', 'head'] as const).filter(side => pick(side === 'base' ? base : head));
  // A run without a stamp cannot be shown current: refuse rather than assume it is.
  const unknown = sides(run => run.stamp === null);
  if (unknown.length) out.push({ code: 'runFreshnessUnknown', sides: unknown });
  const stale = sides(run => run.stamp !== null && ctx.isStale(run));
  if (stale.length) out.push({ code: 'runStale', sides: stale });
  return out;
}

export function reconcileRuns(base: CapturedRun, head: CapturedRun, ctx: ReconcileContext | null): ReconcileOutcome {
  const incompatibilities = runIncompatibilities(base, head, ctx);
  if (incompatibilities.length || !ctx) {
    return { ok: false, kind: base.kind === head.kind ? base.kind : null, baseRunId: base.id, headRunId: head.id, incompatibilities };
  }
  if (base.kind === 'clash' && head.kind === 'clash') return reconcileClashRuns(base, head, ctx);
  if (base.kind === 'validation' && head.kind === 'validation') return reconcileValidationRuns(base, head, ctx);
  return { ok: false, kind: null, baseRunId: base.id, headRunId: head.id, incompatibilities: [{ code: 'kindDiffers' }] };
}
