/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Renderer } from '@ifc-lite/renderer';
import type { ViewerState } from '@/store';
import type { AppearanceAssetInventory } from '../assets.js';
import { appearanceAssets } from '../model-assets.js';
import { referenceRenderCorners } from './frame.js';

export type ReferenceRuntimeStatus = 'ready' | 'hidden' | 'loading' | 'missing-asset' | 'frame-mismatch' | 'error';
export interface ReferenceRuntimeDiagnostic { id: string; status: ReferenceRuntimeStatus; message?: string }
interface ReferenceStore {
  getState(): ViewerState;
  subscribe(listener: (state: ViewerState) => void): () => void;
}
interface Job { key: string; abort: AbortController }

/** Mount once beside the viewer renderer. Owns only registered-reference GPU
 * handles; draft IDs belong to their controller and are never cleared here. */
export function connectAppearanceReferences(
  renderer: Pick<Renderer, 'getReferenceImages' | 'onDeviceLost'>, store: ReferenceStore,
  onDiagnostic: (diagnostic: ReferenceRuntimeDiagnostic) => void,
  inventory: AppearanceAssetInventory = appearanceAssets,
): () => void {
  const channel = renderer.getReferenceImages(), jobs = new Map<string, Job>();
  const diagnostics = new Map<string, string>();
  const report = (diagnostic: ReferenceRuntimeDiagnostic) => {
    const key = JSON.stringify([diagnostic.status, diagnostic.message]);
    if (diagnostics.get(diagnostic.id) === key) return;
    diagnostics.set(diagnostic.id, key); onDiagnostic(diagnostic);
  };
  const runtimeId = crypto.randomUUID();
  let disposed = false;
  const remove = (id: string) => { jobs.get(id)?.abort.abort(); jobs.delete(id); channel.remove(id); };
  const sync = (state: ViewerState) => {
    if (disposed) return;
    for (const id of diagnostics.keys()) if (!state.appearanceReferences.has(id)) diagnostics.delete(id);
    for (const id of jobs.keys()) if (!state.appearanceReferences.has(id)) remove(id);
    for (const [id, record] of state.appearanceReferences) {
      const corners = referenceRenderCorners(record, state);
      const unavailable = !record.visible ? 'hidden' : !corners ? 'frame-mismatch' : !inventory.get(record.assetId) ? 'missing-asset' : null;
      if (unavailable) { if (jobs.has(id)) remove(id); report({ id, status: unavailable }); continue; }
      const key = JSON.stringify([record.assetId, corners, record.locked, record.opacity]);
      if (jobs.get(id)?.key === key) continue;
      // Keep the previous valid raster visible until its replacement uploads.
      jobs.get(id)?.abort.abort();
      jobs.delete(id);
      const abort = new AbortController();
      const job = { key, abort };
      jobs.set(id, job);
      report({ id, status: 'loading' });
      const owner = { kind: 'draft' as const, id: `reference-runtime:${runtimeId}:${id}:${crypto.randomUUID()}` };
      inventory.retain(record.assetId, owner);
      void (async () => {
        try {
          const bitmap = await inventory.decode(record.assetId, owner, abort.signal);
          if (disposed || jobs.get(id) !== job || !corners) return;
          await channel.set({ id, bitmap, corners, visible: true, locked: record.locked, opacity: record.opacity }, abort.signal);
          if (!disposed && jobs.get(id) === job) report({ id, status: 'ready' });
        } catch (error) {
          if (!abort.signal.aborted && !disposed && jobs.get(id) === job) {
            report({ id, status: 'error', message: error instanceof Error ? error.message : 'Could not display this reference image.' });
          }
        } finally { inventory.release(record.assetId, owner); }
      })();
    }
  };
  const unsubscribe = store.subscribe(sync);
  const lost = renderer.onDeviceLost(() => { for (const id of jobs.keys()) remove(id); });
  sync(store.getState());
  return () => { disposed = true; unsubscribe(); lost(); for (const id of jobs.keys()) remove(id); };
}
