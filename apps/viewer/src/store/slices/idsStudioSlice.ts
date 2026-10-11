/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS Studio state (IDS-030): the open Studio document with its undo history,
 * the selected node and the transient UI around it.
 *
 * The document changes ONLY through `idsStudioDispatch` (gate + reducer, see
 * `lib/ids-studio/session.ts`) and `idsStudioUndo` / `idsStudioRedo`, which
 * replay already-gated inverses. Opening a document replaces it wholesale; it
 * is not an edit.
 */

import type { StateCreator } from 'zustand';
import {
  canRedo,
  canUndo,
  createStudioState,
  locateNode,
  redo,
  undo,
  type GateIssue,
  type StudioDocument,
  type StudioOp,
  type StudioState,
  type Uuid,
} from '@ifc-lite/ids-authoring';
import { dispatchStudioOps, type StudioDispatchInfo } from '@/lib/ids-studio/session';
import type { StudioContexts } from '@/lib/ids-studio/context';
import { defineSliceTeardown, notApplicable } from '../teardown.js';

export type IdsStudioView = 'inspector' | 'xml';

/** A quick fix the user is previewing: which diagnostic, which of its fixes. */
export interface IdsStudioFixPreview {
  key: string;
  fixIndex: number;
}

export type IdsStudioDispatchOutcome = { ok: true } | { ok: false; issues: GateIssue[] };

/** The last refused batch: the gate's issues, and the batch itself so a remedy can resubmit it. */
export interface IdsStudioRejection {
  issues: GateIssue[];
  ops: readonly StudioOp[];
  label?: string;
}

export interface IdsStudioSlice {
  /** The open document and its history; `null` until one is created or opened. */
  idsStudioState: StudioState | null;
  /** Bumps on every document change, undo and redo included. */
  idsStudioRevision: number;
  idsStudioSelection: Uuid | null;
  /** Schema tables for the gate and lint; `null` while loading. */
  idsStudioContexts: StudioContexts | null;
  /** The last refused batch; cleared by the next accepted one. */
  idsStudioRejection: IdsStudioRejection | null;
  idsStudioView: IdsStudioView;
  idsStudioFixPreview: IdsStudioFixPreview | null;

  idsStudioOpen: (doc: StudioDocument) => void;
  idsStudioClose: () => void;
  /** Gate + commit as one undo step. Refused batches change nothing. */
  idsStudioDispatch: (ops: readonly StudioOp[], info?: StudioDispatchInfo) => IdsStudioDispatchOutcome;
  idsStudioUndo: () => void;
  idsStudioRedo: () => void;
  idsStudioSelect: (id: Uuid | null) => void;
  idsStudioSetContexts: (contexts: StudioContexts) => void;
  idsStudioSetView: (view: IdsStudioView) => void;
  idsStudioSetFixPreview: (preview: IdsStudioFixPreview | null) => void;
  idsStudioDismissRejection: () => void;
}

const LOADING_ISSUE: GateIssue = {
  ok: false, code: 'GATE-OP-001', path: 'ops', opIndex: 0, candidates: [],
  message: 'The IFC schema tables are still loading; nothing was changed.',
};

/** Keep the selection only while its node still exists (undo may remove it). */
function liveSelection(doc: StudioDocument, id: Uuid | null): Uuid | null {
  if (!id) return null;
  return id === doc.nodes.document || locateNode(doc, id) ? id : null;
}

export const createIdsStudioSlice: StateCreator<IdsStudioSlice, [], [], IdsStudioSlice> = (set, get) => {
  function replace(state: StudioState): void {
    set({
      idsStudioState: state,
      idsStudioRevision: get().idsStudioRevision + 1,
      idsStudioSelection: liveSelection(state.doc, get().idsStudioSelection),
      idsStudioFixPreview: null,
    });
  }
  return {
    idsStudioState: null,
    idsStudioRevision: 0,
    idsStudioSelection: null,
    idsStudioContexts: null,
    idsStudioRejection: null,
    idsStudioView: 'inspector',
    idsStudioFixPreview: null,

    idsStudioOpen: (doc) => {
      set({
        idsStudioState: createStudioState(doc),
        idsStudioRevision: get().idsStudioRevision + 1,
        idsStudioSelection: null,
        idsStudioRejection: null,
        idsStudioFixPreview: null,
      });
    },
    idsStudioClose: () => {
      set({ idsStudioState: null, idsStudioRevision: get().idsStudioRevision + 1, idsStudioSelection: null,
        idsStudioRejection: null, idsStudioFixPreview: null });
    },
    idsStudioDispatch: (ops, info) => {
      const { idsStudioState: state, idsStudioContexts: contexts } = get();
      if (!state) return { ok: false, issues: [{ ...LOADING_ISSUE, message: 'No IDS document is open.' }] };
      const refuse = (issues: GateIssue[]): IdsStudioDispatchOutcome => {
        set({ idsStudioRejection: { issues, ops, ...(info?.label ? { label: info.label } : {}) } });
        return { ok: false, issues };
      };
      if (!contexts) return refuse([LOADING_ISSUE]);
      const result = dispatchStudioOps(state, ops, contexts.gate, info);
      if (!result.ok) return refuse(result.issues);
      if (result.state !== state) replace(result.state);
      set({ idsStudioRejection: null });
      return { ok: true };
    },
    idsStudioUndo: () => {
      const state = get().idsStudioState;
      if (state && canUndo(state)) replace(undo(state));
    },
    idsStudioRedo: () => {
      const state = get().idsStudioState;
      if (state && canRedo(state)) replace(redo(state));
    },
    idsStudioSelect: (id) => set({ idsStudioSelection: id }),
    idsStudioSetContexts: (contexts) => set({ idsStudioContexts: contexts }),
    idsStudioSetView: (view) => set({ idsStudioView: view }),
    idsStudioSetFixPreview: (preview) => set({ idsStudioFixPreview: preview }),
    idsStudioDismissRejection: () => set({ idsStudioRejection: null }),
  };
};

/**
 * The Studio document is the user's work and is not model-derived, so no
 * model removal or reset destroys it (like the IDS slice's `idsDocument`).
 * A session reset clears only the transient feedback around it.
 */
export const idsStudioTeardown = defineSliceTeardown(
  'idsStudioSlice',
  ['idsStudioRejection', 'idsStudioFixPreview'],
  {
    'session-reset': (_scope, state) => ({
      ...(state.idsStudioRejection ? { idsStudioRejection: null } : {}),
      ...(state.idsStudioFixPreview ? { idsStudioFixPreview: null } : {}),
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
