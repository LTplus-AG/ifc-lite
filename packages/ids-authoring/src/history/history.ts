/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Undo/redo history (§4). A history entry is one TRANSACTION: an AI
 * proposal, a paste or a template application is one entry, so a single
 * undo reverts it entirely.
 *
 * Everything here is pure: `commit`, `undo` and `redo` return a new
 * `StudioState`. Entries are plain JSON so a host can persist them (see
 * `PersistenceAdapter`) and undo across a reload.
 *
 * Undo and redo replay exact inverses / recorded primitives of ops that
 * already passed the gate, so they do not consult the gate again.
 */

import type { StudioDocument } from '../document/types.js';
import type { PrimitiveOp, StudioOp } from '../ops/types.js';
import { apply, type ApplyResult } from '../reducer/apply.js';
import { uuidv7, type Uuid } from '../uuid.js';

/** Who or what produced a history entry. */
export type HistorySource =
  | { by: 'user'; userId?: string }
  | { by: 'ai'; runId: Uuid; model: string }
  | { by: 'import'; format: 'ids' | 'xlsx' | 'csv' | 'yaml' | 'bsdd' | 'template' | 'infer'; ref?: string };

export interface HistoryEntry {
  id: Uuid;
  /** The ops as submitted (compound ops kept as such). */
  ops: StudioOp[];
  /** The primitives actually applied; redo replays these. */
  expanded: PrimitiveOp[];
  /** Undo ops, in apply order. */
  inverses: PrimitiveOp[];
  /** ISO timestamp. */
  at: string;
  source?: HistorySource;
  label?: string;
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export interface StudioState {
  doc: StudioDocument;
  history: History;
}

export interface CommitInfo {
  at?: string;
  source?: HistorySource;
  label?: string;
  entryId?: Uuid;
}

/** Default number of undo steps kept. */
export const DEFAULT_HISTORY_LIMIT = 500;

export function createStudioState(doc: StudioDocument): StudioState {
  return { doc, history: { past: [], future: [] } };
}

/**
 * Apply `ops` as one history entry. Throws `OpApplyError` (state unchanged)
 * when an op does not apply; run `checkOps` first to get data instead.
 */
export function commit(
  state: StudioState,
  ops: readonly StudioOp[],
  info: CommitInfo = {},
  limit = DEFAULT_HISTORY_LIMIT,
): { state: StudioState; result: ApplyResult } {
  const result = apply(state.doc, ops);
  if (result.expanded.length === 0) return { state, result };
  const entry: HistoryEntry = {
    id: info.entryId ?? uuidv7(),
    ops: [...ops],
    expanded: result.expanded,
    inverses: result.inverses,
    at: info.at ?? new Date().toISOString(),
  };
  if (info.source) entry.source = info.source;
  if (info.label) entry.label = info.label;
  const past = [...state.history.past, entry];
  return {
    state: { doc: result.doc, history: { past: past.slice(Math.max(0, past.length - limit)), future: [] } },
    result,
  };
}

export function canUndo(state: StudioState): boolean {
  return state.history.past.length > 0;
}

export function canRedo(state: StudioState): boolean {
  return state.history.future.length > 0;
}

/** Revert the latest entry. Returns `state` unchanged when there is nothing to undo. */
export function undo(state: StudioState): StudioState {
  const entry = state.history.past[state.history.past.length - 1];
  if (!entry) return state;
  const { doc } = apply(state.doc, entry.inverses);
  return {
    doc,
    history: { past: state.history.past.slice(0, -1), future: [entry, ...state.history.future] },
  };
}

/** Re-apply the most recently undone entry. */
export function redo(state: StudioState): StudioState {
  const entry = state.history.future[0];
  if (!entry) return state;
  const result = apply(state.doc, entry.expanded);
  return {
    doc: result.doc,
    history: { past: [...state.history.past, { ...entry, inverses: result.inverses }], future: state.history.future.slice(1) },
  };
}

/**
 * A transaction collects ops applied step by step (e.g. a drag, or an agent
 * iterating in a sandbox) and commits them as ONE history entry.
 */
export interface Transaction {
  /** The document with every op applied so far. */
  readonly doc: StudioDocument;
  readonly ops: readonly StudioOp[];
  /** Apply more ops to the preview; throws `OpApplyError` and keeps the previous preview. */
  apply(ops: readonly StudioOp[]): void;
  /** One history entry for everything applied. */
  commit(info?: CommitInfo): StudioState;
  /** Drop everything; returns the state the transaction started from. */
  rollback(): StudioState;
}

export function beginTransaction(state: StudioState): Transaction {
  let doc = state.doc;
  const ops: StudioOp[] = [];
  return {
    get doc() {
      return doc;
    },
    get ops() {
      return ops;
    },
    apply(more) {
      doc = apply(doc, more).doc;
      ops.push(...more);
    },
    commit(info) {
      return commit(state, ops, info).state;
    },
    rollback() {
      return state;
    },
  };
}
