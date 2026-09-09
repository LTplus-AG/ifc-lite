/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import { useViewerStore } from '@/store';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';
import { makePlacementManifest, parsePlacementManifest, type PlacementManifest } from '@/lib/model-placement/manifest';
import { placementFrameKey } from '@/lib/model-placement/persistence';

/** Imported files are validated before offering an explicit instance mapping. */
export function PlacementFiles() {
  const models = useViewerStore((state) => state.models);
  const [manifest, setManifest] = useState<PlacementManifest | null>(null);
  const [bindings, setBindings] = useState(new Map<string, string>());
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const read = async (file: File) => {
    try {
      if (file.size > 2_000_000) throw new Error('Placement manifest exceeds 2 MB.');
      const document = parsePlacementManifest(await file.text());
      const state = useViewerStore.getState();
      if (document.frameKey !== placementFrameKey(state)) throw new Error('This file uses a different workspace coordinate frame.');
      const next = new Map<string, string>();
      for (const entry of document.models) {
        const matches = [...state.models].filter(([id, model]) => entry.sourceContentHash
          ? model.sourceContentHash === entry.sourceContentHash : id === entry.instanceId);
        if (matches.length === 1) next.set(entry.instanceId, matches[0][0]);
      }
      setBindings(next); setManifest(document); setError(''); setStatus('Review the model mapping, then import positions.');
    } catch (err) { setStatus(''); setError(err instanceof Error ? err.message : String(err)); setManifest(null); }
  };
  return <details className="border-t pt-2"><summary>Save or restore placements</summary>
    <p>Positions are saved in this browser for matching source files. Export a placement file to transfer them. Original model files stay unchanged.</p>
    <button className="border px-2 py-1" onClick={() => {
      const state = useViewerStore.getState();
      const value = makePlacementManifest(state.models, state.modelPlacement.placements, placementFrameKey(state));
      downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), `${sanitizeFilename('model-placements')}.json`);
    }}>Export placements</button>
    <label className="block">Open placement file<input aria-label="Open placement file" type="file" accept=".json,application/json"
      onChange={(event) => { const file = event.target.files?.[0]; if (file) void read(file); event.target.value = ''; }} /></label>
    {manifest && <fieldset><legend>Match saved instances to loaded models</legend>
      {manifest.models.map((entry) => <label className="block" key={entry.instanceId}>{entry.instanceId}
        <select aria-label={`Bind ${entry.instanceId}`} value={bindings.get(entry.instanceId) ?? ''} className="border w-full bg-transparent"
          onChange={(event) => setBindings((prior) => new Map(prior).set(entry.instanceId, event.target.value))}>
          <option value="">Choose matching source</option>
          {[...models].filter(([, model]) => entry.sourceContentHash === null || entry.sourceContentHash === model.sourceContentHash)
            .map(([id, model]) => <option key={id} value={id}>{model.name} ({id})</option>)}
        </select></label>)}
      <p>Import changes positions as one undoable operation. Current position locks are preserved.</p>
      <button className="border px-2 py-1" onClick={() => {
        try {
          if (manifest.models.some((entry) => !bindings.get(entry.instanceId))) throw new Error('Map every saved instance before importing.');
          useViewerStore.getState().importModelPlacements(manifest, bindings);
          setManifest(null); setError(''); setStatus('Positions imported. Undo move restores the previous positions.');
        } catch (err) { setStatus(''); setError(err instanceof Error ? err.message : String(err)); }
      }}>Import positions</button>
    </fieldset>}
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </details>;
}
