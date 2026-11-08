/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CopyTransform } from '@ifc-lite/create';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui/toast';
import { selectedElements } from '@/lib/commands/modeling/copy-clipboard';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter';
import { copySources } from '@/lib/commands/modeling/copy-elements';
import { formatStoreyElevation } from '../StoreyPicker';

/** #9296: one transform per storey, one atomic copy, one undo step. */
export function CopyToStoreys() {
  const { t } = useTranslation();
  const [selection] = useState(() => selectedElements(useViewerStore.getState()));
  const [levels] = useState(() => selection ? modelStoreys(useViewerStore.getState(), selection.modelId) : []);
  const [rangeStart, setRangeStart] = useState<string>();
  const [rangeEnd, setRangeEnd] = useState<string>();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const version = useRef(useViewerStore.getState().mutationVersion);
  const generation = useRef(0);
  const prepared = useRef<CopyTransform[]>([]);
  useEffect(() => () => { generation.current++; }, []);
  const chooseRange = (start: string | undefined, end: string | undefined) => {
    setRangeStart(start); setRangeEnd(end);
    if (start === undefined || end === undefined) return;
    const a = levels.findIndex(level => String(level.expressId) === start);
    const b = levels.findIndex(level => String(level.expressId) === end);
    setPicked(new Set(levels.slice(Math.min(a, b), Math.max(a, b) + 1).map(level => level.expressId)));
  };
  const cancel = () => { generation.current++; setProgress(null); setReady(false); prepared.current = []; };
  const prepare = async () => {
    if (!selection) return;
    const token = ++generation.current;
    version.current = useViewerStore.getState().mutationVersion;
    setProgress(0);
    prepared.current = [];
    try {
      const sources = copySources(useViewerStore.getState(), selection.modelId, selection.ids);
      if ('refusal' in sources) throw new Error(sources.refusal);
      for (const [index, targetStoreyId] of [...picked].entries()) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (generation.current !== token) return;
      const plane = buildStoreyWorkplane(useViewerStore.getState(), selection.modelId, targetStoreyId, 0);
      if (!isWorkplane(plane)) throw new Error(t('storeyManager.copy.stale'));
      prepared.current.push({ targetStoreyId });
      setProgress(index + 1);
    }
      setReady(true);
    } catch (error) {
      toast.error(t('storeyManager.refusal.other', { reason: error instanceof Error ? error.message : String(error) }));
      cancel();
    }
  };
  const commit = () => {
    if (!selection) return;
    try {
      if (version.current !== useViewerStore.getState().mutationVersion) throw new Error(t('storeyManager.copy.stale'));
      const sources = copySources(useViewerStore.getState(), selection.modelId, selection.ids);
      if ('refusal' in sources) throw new Error(sources.refusal);
      setBusy(true);
      const copies = createStoreAdapter(useViewerStore).copyElements!(selection.modelId, sources.ids, prepared.current);
      toast.success(t('storeyManager.copy.done', { count: copies.length }));
      cancel();
    } catch (error) {
      toast.error(t('storeyManager.refusal.other', { reason: error instanceof Error ? error.message : String(error) }));
      cancel();
    } finally { setBusy(false); }
  };
  return <div data-copy-to-storeys className="flex w-64 flex-col gap-2 p-2">
    <p className="text-xs font-medium">{t('storeyManager.copy.title')}</p>
    {!selection ? <p className="text-xs">{t('storeyManager.copy.empty')}</p> : <>
      <Button size="sm" variant="outline" disabled={progress !== null} onClick={() => setPicked(new Set(levels.map(s => s.expressId)))}>{t('storeyManager.copy.all')}</Button>
      <div className="flex gap-1">
        {(['from', 'to'] as const).map(edge => <Select key={edge} disabled={progress !== null} value={edge === 'from' ? rangeStart : rangeEnd} onValueChange={value => chooseRange(edge === 'from' ? value : rangeStart, edge === 'to' ? value : rangeEnd)}>
          <SelectTrigger aria-label={t(edge === 'from' ? 'storeyManager.copy.from' : 'storeyManager.copy.to')} className="h-7 text-xs"><SelectValue placeholder={t(edge === 'from' ? 'storeyManager.copy.from' : 'storeyManager.copy.to')} /></SelectTrigger>
          <SelectContent>{levels.map(level => <SelectItem key={level.expressId} value={String(level.expressId)}>{level.name}</SelectItem>)}</SelectContent>
        </Select>)}
      </div>
      <div className="max-h-48 space-y-1 overflow-y-auto">
        {levels.map(level => <Checkbox key={level.expressId} disabled={progress !== null} checked={picked.has(level.expressId)} label={t('storeyManager.copy.level', { storey: level.name, elevation: formatStoreyElevation(level.elevation) })} onCheckedChange={checked => setPicked(current => { const next = new Set(current); if (checked) next.add(level.expressId); else next.delete(level.expressId); return next; })} />)}
      </div>
      {progress !== null && <output className="text-xs" aria-live="polite">{t(ready ? 'storeyManager.copy.ready' : 'storeyManager.copy.progress', { count: picked.size, progress: progress ?? 0, elements: selection.ids.length * picked.size })}</output>}
      <div className="flex gap-2">
        <Button size="sm" disabled={!picked.size || busy || (progress !== null && !ready)} onClick={() => { if (ready) commit(); else void prepare(); }}>{t(ready ? 'storeyManager.copy.commit' : 'storeyManager.copy.prepare')}</Button>
        {progress !== null && <Button size="sm" variant="ghost" disabled={busy} onClick={cancel}>{t('storeyManager.copy.cancel')}</Button>}
      </div>
    </>}
  </div>;
}
