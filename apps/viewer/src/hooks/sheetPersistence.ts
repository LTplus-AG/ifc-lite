/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sheet ownership follows the active drawing model (#4836). The drawing hook
 * supplies its existing full-content hash; this bridge never re-hashes a file.
 * A raw subscription switches sheets before React effects run. Edits made while
 * a hash is pending win over disk restoration, including an explicit clear.
 */
import type { DrawingSheet } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { loadSheet, loadSheetTemplates, saveSheet, saveSheetTemplates } from '@/store/slices/sheetSlice.persistence';
import { getClearedSheetState } from '@/store/slices/sheetSlice';

interface SessionSheet {
  source: File | undefined;
  sheet: DrawingSheet | null;
  hash?: string | null;
  dirty: boolean;
  enabled: boolean;
}

export function createSheetPersistence() {
  const sheets = new Map<string, SessionSheet>();
  // A replacement may arrive before the old source's hash finishes. Keep its
  // unsaved edit reachable by that source, without retaining closed File blobs.
  const pendingReplacements = new WeakMap<File, Map<string, SessionSheet>>();
  let applying = false;

  const apply = (entry?: SessionSheet, resetUi = true) => {
    applying = true;
    try {
      useViewerStore.setState(resetUi
        ? { ...getClearedSheetState(), activeSheet: entry?.sheet ?? null, sheetEnabled: entry?.enabled ?? false }
        : { activeSheet: entry?.sheet ?? null });
    } finally {
      applying = false;
    }
  };

  const remember = (modelId: string, source: File | undefined): SessionSheet => {
    let entry = sheets.get(modelId);
    if (!entry || entry.source !== source) {
      if (entry?.source && entry.hash === undefined && entry.dirty) {
        let pending = pendingReplacements.get(entry.source);
        if (!pending) pendingReplacements.set(entry.source, pending = new Map());
        pending.set(modelId, entry);
      }
      // Returning to the same source before hashing completes must resume its
      // original edit session, not create a blank session that shadows it.
      const pending = source ? pendingReplacements.get(source) : undefined;
      entry = pending?.get(modelId) ?? { source, sheet: null, dirty: false, enabled: false };
      pending?.delete(modelId);
      sheets.set(modelId, entry);
    }
    return entry;
  };

  const initial = useViewerStore.getState();
  // Preserve any templates created before this bridge mounted.
  const templates = new Map(loadSheetTemplates().map((sheet) => [sheet.id, sheet]));
  for (const sheet of initial.savedSheetTemplates) templates.set(sheet.id, sheet);
  const mergedTemplates = [...templates.values()];
  useViewerStore.setState({ savedSheetTemplates: mergedTemplates });
  if (initial.savedSheetTemplates.length > 0) saveSheetTemplates(mergedTemplates);
  if (initial.activeModelId) {
    const entry = remember(initial.activeModelId, initial.models.get(initial.activeModelId)?.sourceFile);
    entry.sheet = initial.activeSheet;
    entry.dirty = initial.activeSheet !== null;
    entry.enabled = initial.sheetEnabled;
  }

  const unsubscribe = useViewerStore.subscribe((state, previous) => {
    if (applying) return;
    if (state.savedSheetTemplates !== previous.savedSheetTemplates) saveSheetTemplates(state.savedSheetTemplates);
    if (state.models !== previous.models) {
      for (const [modelId, entry] of sheets) {
        // Pending hashes may still need to save edits. Settled, closed models
        // must release their File handles and embedded logos.
        if (!state.models.has(modelId) && entry.hash !== undefined) sheets.delete(modelId);
      }
    }
    const id = state.activeModelId;
    const source = id ? state.models.get(id)?.sourceFile : undefined;
    const oldSource = previous.activeModelId ? previous.models.get(previous.activeModelId)?.sourceFile : undefined;
    if (id !== previous.activeModelId || source !== oldSource) {
      // An atomic session reset may already have cleared activeSheet in state;
      // the outgoing entry was saved on the last real edit, never save this clear.
      apply(id ? remember(id, source) : undefined);
      return;
    }
    if (!id) return;
    const entry = remember(id, source);
    entry.enabled = state.sheetEnabled;
    if (state.activeSheet === previous.activeSheet) return;
    entry.sheet = state.activeSheet;
    entry.dirty = true;
    if (entry.hash) saveSheet(entry.hash, entry.sheet);
  });

  return {
    settleHash(modelId: string, hash: string | null, source: File | undefined, fallback?: DrawingSheet) {
      const current = sheets.get(modelId);
      const pending = source ? pendingReplacements.get(source) : undefined;
      const entry = current?.source === source ? current : pending?.get(modelId);
      if (!entry) return;
      pending?.delete(modelId);
      entry.hash = hash;
      const state = useViewerStore.getState();
      if (hash && entry.dirty) saveSheet(hash, entry.sheet);
      else if (hash) {
        entry.sheet = fallback ?? loadSheet(hash);
        if (state.activeModelId === modelId && state.models.get(modelId)?.sourceFile === source) apply(entry, false);
      }
      if (current === entry && !state.models.has(modelId)) sheets.delete(modelId);
    },
    /** Whether `source`'s session holds an edit that only a resolved key can save (#7035). */
    hasUnsavedEdit(modelId: string, source: File): boolean {
      const current = sheets.get(modelId);
      const entry = current?.source === source ? current : pendingReplacements.get(source)?.get(modelId);
      return !!entry?.dirty && entry.hash === undefined;
    },
    dispose: unsubscribe,
  };
}

export function hasUnsavedSheetEdit(modelId: string, source: File): boolean {
  return persistence?.hasUnsavedEdit(modelId, source) ?? false;
}

let persistence: ReturnType<typeof createSheetPersistence> | undefined;
export function ensureSheetPersistence(): void {
  persistence ??= createSheetPersistence();
}

export function settleSheetHash(modelId: string, hash: string | null, source: File | undefined, fallback?: DrawingSheet): void {
  persistence?.settleHash(modelId, hash, source, fallback);
}
