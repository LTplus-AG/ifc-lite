/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one write path of IDS Studio (ADR-002/003): every edit is a batch of
 * `@ifc-lite/ids-authoring` ops that passes the grounding gate, then the
 * reducer commits it as one history entry. Nothing in the Studio UI builds
 * or mutates an `IDSDocument` itself.
 *
 * Pure: the store slice (`store/slices/idsStudioSlice.ts`) holds the result.
 */

import {
  checkOps,
  commit,
  OpApplyError,
  type GateContext,
  type GateIssue,
  type HistorySource,
  type StudioOp,
  type StudioState,
  type Uuid,
} from '@ifc-lite/ids-authoring';

export type StudioDispatchResult =
  | { ok: true; state: StudioState; touched: ReadonlySet<Uuid> }
  /** Refused: the state is unchanged. `issues` are the gate's data, shown as-is. */
  | { ok: false; state: StudioState; issues: GateIssue[] };

export interface StudioDispatchInfo {
  label?: string;
  source?: HistorySource;
}

const USER: HistorySource = { by: 'user' };

/** An issue for a batch the reducer refused after the gate let it through (a stale node id). */
function applyIssue(error: OpApplyError): GateIssue {
  return { ok: false, code: 'GATE-STR-001', path: 'ops', message: error.message, candidates: [], opIndex: 0 };
}

/**
 * Gate `ops` against the current document and, when every op passes, commit
 * them as ONE undo step. An empty batch is a no-op success.
 */
export function dispatchStudioOps(
  state: StudioState,
  ops: readonly StudioOp[],
  ctx: GateContext,
  info: StudioDispatchInfo = {},
): StudioDispatchResult {
  if (ops.length === 0) return { ok: true, state, touched: new Set() };
  const gate = checkOps(ops, state.doc, ctx);
  if (!gate.ok) return { ok: false, state, issues: gate.issues };
  try {
    const committed = commit(state, ops, { source: info.source ?? USER, ...(info.label ? { label: info.label } : {}) });
    return { ok: true, state: committed.state, touched: committed.result.touched };
  } catch (error) {
    // The gate checks the batch against this very document, so a refusal here
    // means the gate and reducer disagree: report it, never half-apply.
    if (error instanceof OpApplyError) {
      console.warn('[ids-studio] the reducer refused a gated batch', error);
      return { ok: false, state, issues: [applyIssue(error)] };
    }
    throw error;
  }
}
