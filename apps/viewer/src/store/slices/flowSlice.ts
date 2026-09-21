/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flow graphs: the saved graphs, the one being edited, and the last run.
 *
 * Saved graphs are workspace preferences (localStorage) and survive every
 * teardown, like scripts and dashboards. The run result, the running flag
 * and the panel flag describe the outgoing model and are cleared on a
 * session reset (`flowSlice.teardown.ts`).
 */

import type { StateCreator } from 'zustand';
import type { FlowDocument, RunResult } from '@ifc-lite/flow';
import { canCreateFlow, isFlowWithinSizeLimit, loadSavedFlows, newFlowDocument, saveFlows, type SavedFlow } from '../../lib/flow/persistence.js';

export interface FlowSlice {
  flowPanelVisible: boolean;
  savedFlows: SavedFlow[];
  /** Id of the saved graph the editor holds, or `null` for none. */
  activeFlowId: string | null;
  /** The working copy the editor mutates; saved back explicitly. */
  flowDoc: FlowDocument | null;
  flowDirty: boolean;
  flowSelectedNodeId: string | null;
  flowRunning: boolean;
  flowLastRun: RunResult | null;
  flowLastError: string | null;

  setFlowPanelVisible: (visible: boolean) => void;
  /** Create, save and open a new graph. Returns `null` when the graph limit is reached. */
  createFlow: (name: string) => string | null;
  openFlow: (id: string) => void;
  /** Persist the working copy; a no-op when nothing is open. */
  saveFlow: () => void;
  deleteFlow: (id: string) => void;
  /** Import a validated document as a new saved graph (a fresh id when one collides). */
  importFlow: (doc: FlowDocument) => string | null;
  /** Replace the working copy (an editor edit); marks it dirty. */
  setFlowDoc: (doc: FlowDocument) => void;
  setFlowSelectedNodeId: (id: string | null) => void;
  setFlowRunning: (running: boolean) => void;
  setFlowLastRun: (run: RunResult | null, error?: string | null) => void;
}

export const createFlowSlice: StateCreator<FlowSlice, [], [], FlowSlice> = (set, get) => ({
  flowPanelVisible: false,
  savedFlows: loadSavedFlows(),
  activeFlowId: null,
  flowDoc: null,
  flowDirty: false,
  flowSelectedNodeId: null,
  flowRunning: false,
  flowLastRun: null,
  flowLastError: null,

  setFlowPanelVisible: (visible) => set({ flowPanelVisible: visible }),

  createFlow: (name) => {
    const { savedFlows } = get();
    if (!canCreateFlow(savedFlows.length)) return null;
    const doc = newFlowDocument(name.trim() || 'Untitled flow');
    const next = [...savedFlows, { doc, updatedAt: Date.now() }];
    saveFlows(next);
    set({ savedFlows: next, activeFlowId: doc.id, flowDoc: doc, flowDirty: false, flowSelectedNodeId: null, flowLastRun: null, flowLastError: null });
    return doc.id;
  },

  openFlow: (id) => {
    const saved = get().savedFlows.find((f) => f.doc.id === id);
    if (!saved) return;
    set({ activeFlowId: id, flowDoc: saved.doc, flowDirty: false, flowSelectedNodeId: null, flowLastRun: null, flowLastError: null });
  },

  saveFlow: () => {
    const { activeFlowId, flowDoc, savedFlows } = get();
    if (!activeFlowId || !flowDoc || !isFlowWithinSizeLimit(flowDoc)) return;
    const entry: SavedFlow = { doc: flowDoc, updatedAt: Date.now() };
    const next = savedFlows.some((f) => f.doc.id === activeFlowId)
      ? savedFlows.map((f) => (f.doc.id === activeFlowId ? entry : f))
      : [...savedFlows, entry];
    saveFlows(next);
    set({ savedFlows: next, flowDirty: false });
  },

  deleteFlow: (id) => {
    const next = get().savedFlows.filter((f) => f.doc.id !== id);
    saveFlows(next);
    const closing = get().activeFlowId === id;
    set({ savedFlows: next, ...(closing ? { activeFlowId: null, flowDoc: null, flowDirty: false, flowSelectedNodeId: null, flowLastRun: null, flowLastError: null } : {}) });
  },

  importFlow: (doc) => {
    const { savedFlows } = get();
    if (!canCreateFlow(savedFlows.length) || !isFlowWithinSizeLimit(doc)) return null;
    const id = savedFlows.some((f) => f.doc.id === doc.id) ? crypto.randomUUID() : doc.id;
    const imported: FlowDocument = { ...doc, id };
    const next = [...savedFlows, { doc: imported, updatedAt: Date.now() }];
    saveFlows(next);
    set({ savedFlows: next, activeFlowId: id, flowDoc: imported, flowDirty: false, flowSelectedNodeId: null, flowLastRun: null, flowLastError: null });
    return id;
  },

  setFlowDoc: (doc) => set({ flowDoc: doc, flowDirty: true }),
  setFlowSelectedNodeId: (id) => set({ flowSelectedNodeId: id }),
  setFlowRunning: (running) => set({ flowRunning: running }),
  setFlowLastRun: (run, error = null) => set({ flowLastRun: run, flowLastError: error, flowRunning: false }),
});
