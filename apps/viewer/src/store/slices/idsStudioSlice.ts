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
 *
 * Lazy boundary: this slice is part of the root store, so it imports NOTHING
 * at runtime from `@ifc-lite/ids-authoring` (types only). The authoring
 * runtime (`lib/ids-studio/runtime.ts`) is installed by `loadIdsStudioRuntime`,
 * which the Studio panel's lazy chunk awaits before it mounts. The actions stay
 * synchronous; called before the runtime is installed, `idsStudioOpen` throws
 * and `idsStudioDispatch` refuses with an issue, never a silent no-op.
 */

import type { StateCreator } from 'zustand';
import type {
  GateIssue,
  StudioDocument,
  StudioOp,
  StudioState,
  Uuid,
} from '@ifc-lite/ids-authoring';
import type { StudioDispatchInfo } from '@/lib/ids-studio/session';
import type { StudioContexts } from '@/lib/ids-studio/context';
import type { IdsStudioRuntime } from '@/lib/ids-studio/runtime';
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
  /** The authoring runtime; `null` until `loadIdsStudioRuntime` installs it. */
  idsStudioRuntime: IdsStudioRuntime | null;
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

  /** Throws when the authoring runtime is not installed yet (see `loadIdsStudioRuntime`). */
  idsStudioOpen: (doc: StudioDocument) => void;
  idsStudioClose: () => void;
  /** Gate + commit as one undo step. Refused batches change nothing. */
  idsStudioDispatch: (ops: readonly StudioOp[], info?: StudioDispatchInfo) => IdsStudioDispatchOutcome;
  idsStudioUndo: () => void;
  idsStudioRedo: () => void;
  idsStudioSelect: (id: Uuid | null) => void;
  idsStudioSetContexts: (contexts: StudioContexts) => void;
  idsStudioSetRuntime: (runtime: IdsStudioRuntime) => void;
  idsStudioSetView: (view: IdsStudioView) => void;
  idsStudioSetFixPreview: (preview: IdsStudioFixPreview | null) => void;
  idsStudioDismissRejection: () => void;
}

const LOADING_ISSUE: GateIssue = {
  ok: false, code: 'GATE-OP-001', path: 'ops', opIndex: 0, candidates: [],
  message: 'The IFC schema tables are still loading; nothing was changed.',
};

const RUNTIME_LOADING_ISSUE: GateIssue = {
  ...LOADING_ISSUE,
  message: 'The IDS Studio authoring runtime is still loading; nothing was changed.',
};

/** Thrown by an action that cannot refuse with data, when called before the runtime is installed. */
const IDS_STUDIO_RUNTIME_NOT_LOADED = 'IDS Studio authoring runtime is not loaded; await loadIdsStudioRuntime() first.';

/** Keep the selection only while its node still exists (undo may remove it). */
function liveSelection(runtime: IdsStudioRuntime, doc: StudioDocument, id: Uuid | null): Uuid | null {
  if (!id) return null;
  return id === doc.nodes.document || runtime.locateNode(doc, id) ? id : null;
}

export const createIdsStudioSlice: StateCreator<IdsStudioSlice, [], [], IdsStudioSlice> = (set, get) => {
  function runtime(): IdsStudioRuntime {
    const installed = get().idsStudioRuntime;
    if (!installed) throw new Error(IDS_STUDIO_RUNTIME_NOT_LOADED);
    return installed;
  }
  function replace(rt: IdsStudioRuntime, state: StudioState): void {
    set({
      idsStudioState: state,
      idsStudioRevision: get().idsStudioRevision + 1,
      idsStudioSelection: liveSelection(rt, state.doc, get().idsStudioSelection),
      idsStudioFixPreview: null,
    });
  }
  return {
    idsStudioRuntime: null,
    idsStudioState: null,
    idsStudioRevision: 0,
    idsStudioSelection: null,
    idsStudioContexts: null,
    idsStudioRejection: null,
    idsStudioView: 'inspector',
    idsStudioFixPreview: null,

    idsStudioOpen: (doc) => {
      set({
        idsStudioState: runtime().createStudioState(doc),
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
      const { idsStudioState: state, idsStudioContexts: contexts, idsStudioRuntime: rt } = get();
      if (!state) return { ok: false, issues: [{ ...LOADING_ISSUE, message: 'No IDS document is open.' }] };
      const refuse = (issues: GateIssue[]): IdsStudioDispatchOutcome => {
        set({ idsStudioRejection: { issues, ops, ...(info?.label ? { label: info.label } : {}) } });
        return { ok: false, issues };
      };
      if (!rt) return refuse([RUNTIME_LOADING_ISSUE]);
      if (!contexts) return refuse([LOADING_ISSUE]);
      const result = rt.dispatchStudioOps(state, ops, contexts.gate, info);
      if (!result.ok) return refuse(result.issues);
      if (result.state !== state) replace(rt, result.state);
      set({ idsStudioRejection: null });
      return { ok: true };
    },
    idsStudioUndo: () => {
      const state = get().idsStudioState;
      if (!state) return;
      const rt = runtime();
      if (rt.canUndo(state)) replace(rt, rt.undo(state));
    },
    idsStudioRedo: () => {
      const state = get().idsStudioState;
      if (!state) return;
      const rt = runtime();
      if (rt.canRedo(state)) replace(rt, rt.redo(state));
    },
    idsStudioSelect: (id) => set({ idsStudioSelection: id }),
    idsStudioSetContexts: (contexts) => set({ idsStudioContexts: contexts }),
    idsStudioSetRuntime: (rt) => set({ idsStudioRuntime: rt }),
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
