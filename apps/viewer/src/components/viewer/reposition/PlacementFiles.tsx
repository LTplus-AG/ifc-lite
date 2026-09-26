/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { trackExportCompleted } from '@/lib/analytics';
import { useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';
import { makePlacementManifest, parsePlacementManifest, type PlacementManifest } from '@/lib/model-placement/manifest';
import { placementFrameKey } from '@/lib/model-placement/persistence';

/** Imported files are validated before offering an explicit instance mapping. */
export function PlacementFiles() {
  const { t } = useTranslation();
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
      setBindings(next); setManifest(document); setError(''); setStatus(t('repositionPanel.files.statusReviewMapping'));
    } catch (err) { setStatus(''); setError(err instanceof Error ? err.message : String(err)); setManifest(null); }
  };
  return <details className="border-t pt-2 text-xs"><summary>{t('repositionPanel.files.summary')}</summary>
    <p className="text-muted-foreground">{t('repositionPanel.files.intro')}</p>
    <Button size="sm" variant="outline" onClick={() => {
      const state = useViewerStore.getState();
      const value = makePlacementManifest(state.models, state.modelPlacement.placements, placementFrameKey(state));
      downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), `${sanitizeFilename('model-placements')}.json`);
      trackExportCompleted({ format: 'json', surface: 'placement_panel' });
    }}>{t('repositionPanel.files.exportButton')}</Button>
    <label className="block">{t('repositionPanel.files.openLabel')}<input aria-label={t('repositionPanel.files.openLabel')} type="file" accept=".json,application/json"
      onChange={(event) => { const file = event.target.files?.[0]; if (file) void read(file); event.target.value = ''; }} /></label>
    {manifest && <fieldset className="space-y-1"><legend>{t('repositionPanel.files.matchLegend')}</legend>
      {manifest.models.map((entry) => <label className="flex flex-col gap-0.5" key={entry.instanceId}>{entry.instanceId}
        <Select value={bindings.get(entry.instanceId) ?? undefined} onValueChange={(value) => setBindings((prior) => new Map(prior).set(entry.instanceId, value))}>
          <SelectTrigger aria-label={t('repositionPanel.files.bindAriaLabel', { instance: entry.instanceId })}><SelectValue placeholder={t('repositionPanel.files.chooseSourceOption')} /></SelectTrigger>
          <SelectContent>
            {[...models].filter(([, model]) => entry.sourceContentHash === null || entry.sourceContentHash === model.sourceContentHash)
              .map(([id, model]) => <SelectItem key={id} value={id}>{model.name} ({id})</SelectItem>)}
          </SelectContent>
        </Select></label>)}
      <p className="text-muted-foreground">{t('repositionPanel.files.importNote')}</p>
      <Button size="sm" variant="outline" onClick={() => {
        try {
          if (manifest.models.some((entry) => !bindings.get(entry.instanceId))) throw new Error('Map every saved instance before importing.');
          useViewerStore.getState().importModelPlacements(manifest, bindings);
          setManifest(null); setError(''); setStatus(t('repositionPanel.files.statusImported'));
        } catch (err) { setStatus(''); setError(err instanceof Error ? err.message : String(err)); }
      }}>{t('repositionPanel.files.importButton')}</Button>
    </fieldset>}
    {status && <p role="status">{status}</p>}{error && <p role="alert" className="text-destructive">{error}</p>}
  </details>;
}
