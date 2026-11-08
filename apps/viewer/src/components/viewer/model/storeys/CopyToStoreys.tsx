/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CopyTransform } from '@ifc-lite/create';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui/toast';
import { selectedElements } from '@/lib/commands/modeling/copy-clipboard';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { createStoreAdapter } from '@/sdk/adapters/store-adapter';
import { mutationDenial } from '@/store/mutation-permission';
import { copySources } from '@/lib/commands/modeling/copy-elements';
import { copySourceSummary } from './copy-summary';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { formatStoreyElevation } from '../StoreyPicker';

/** #9296: one transform per storey, one atomic copy, one undo step. */
export function CopyToStoreys({ onDone }: { onDone?: () => void } = {}) {
  const { t } = useTranslation();
  const [selection] = useState(() => selectedElements(useViewerStore.getState()));
  const denial = useViewerStore(s => selection ? mutationDenial(s, selection.modelId) : null);
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
  useEffect(() => {
    if (denial === null) return;
    generation.current++;
    prepared.current = [];
    setProgress(null);
    setReady(false);
    setBusy(false);
  }, [denial]);
  const chooseRange = (start: string | undefined, end: string | undefined) => {
    setRangeStart(start); setRangeEnd(end);
    if (start === undefined || end === undefined) return;
    const a = levels.findIndex(level => String(level.expressId) === start);
    const b = levels.findIndex(level => String(level.expressId) === end);
    setPicked(new Set(levels.slice(Math.min(a, b), Math.max(a, b) + 1).map(level => level.expressId)));
  };
  const cancel = () => { generation.current++; setProgress(null); setReady(false); setBusy(false); prepared.current = []; };
  const prepare = async () => {
    if (!selection || denial !== null) return;
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
  const commit = async () => {
    if (!selection || denial !== null) return;
    const token = generation.current;
    const entry = useViewerStore.getState().session?.entry;
    setBusy(true);
    try {
      // Paint a real busy state before the synchronous, atomic store operation.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (token !== generation.current) return;
      if (useViewerStore.getState().session?.entry !== entry) { cancel(); return; }
      const refused = mutationDenial(useViewerStore.getState(), selection.modelId);
      if (refused) throw new Error(refused);
      if (version.current !== useViewerStore.getState().mutationVersion) throw new Error(t('storeyManager.copy.stale'));
      const sources = copySources(useViewerStore.getState(), selection.modelId, selection.ids);
      if ('refusal' in sources) throw new Error(sources.refusal);
      const copies = createStoreAdapter(useViewerStore).copyElements!(selection.modelId, sources.ids, prepared.current);
      const state = useViewerStore.getState();
      const top = state.undoStacks.get(selection.modelId)?.at(-1);
      const step = top ? state.mutationBatchTags.get(top.id) ?? top.id : null;
      toast.success(t('storeyManager.copy.done', { count: copies.length, targets: t('storeyManager.copy.targets', { count: picked.size }) }), [
        { label: t('storeyManager.copy.show'), dismiss: false, onClick: () => {
          if (!useViewerStore.getState().models.has(selection.modelId)) return;
          useViewerStore.getState().clearIsolation();
          applyLevelDisplayMode('stacked');
          useViewerStore.getState().setStoreyContextMode('all');
        } },
        { label: t('storeyManager.undo'), onClick: () => {
          const now = useViewerStore.getState();
          const denied = mutationDenial(now, selection.modelId);
          if (denied) { toast.error(t('storeyManager.copy.readOnly', { reason: denied })); return; }
          const latest = now.undoStacks.get(selection.modelId)?.at(-1);
          const latestStep = latest ? now.mutationBatchTags.get(latest.id) ?? latest.id : null;
          if (step && latestStep === step) now.undo(selection.modelId);
          else toast.error(t('storeyManager.copy.undoStale'));
        } },
      ], `copy-to-storeys:${selection.modelId}`);
      cancel();
      onDone?.();
    } catch (error) {
      toast.error(t('storeyManager.refusal.other', { reason: error instanceof Error ? error.message : String(error) }));
      cancel();
    } finally { if (token === generation.current) setBusy(false); }
  };
  return <div data-copy-to-storeys className="flex w-64 flex-col gap-2 p-2">
    <p className="text-xs font-medium">{t('storeyManager.copy.title')}</p>
    {denial !== null && <output className="text-xs text-muted-foreground">{t('storeyManager.copy.readOnly', { reason: denial })}</output>}
    {!selection ? <p className="text-xs">{t('storeyManager.copy.empty')}</p> : <>
      {progress === null && <>
      <Button size="sm" variant="outline" disabled={denial !== null || progress !== null} onClick={() => setPicked(new Set(levels.map(s => s.expressId)))}>{t('storeyManager.copy.all')}</Button>
      <div className="flex gap-1">
        {(['from', 'to'] as const).map(edge => <Select key={edge} disabled={denial !== null || progress !== null} value={edge === 'from' ? rangeStart : rangeEnd} onValueChange={value => chooseRange(edge === 'from' ? value : rangeStart, edge === 'to' ? value : rangeEnd)}>
          <SelectTrigger aria-label={t(edge === 'from' ? 'storeyManager.copy.from' : 'storeyManager.copy.to')} className="h-7 text-xs"><SelectValue placeholder={t(edge === 'from' ? 'storeyManager.copy.from' : 'storeyManager.copy.to')} /></SelectTrigger>
          <SelectContent>{levels.map(level => <SelectItem key={level.expressId} value={String(level.expressId)}>{level.name}</SelectItem>)}</SelectContent>
        </Select>)}
      </div>
      </>}
      <div className="max-h-48 space-y-1 overflow-y-auto">
        {levels.map(level => progress !== null ? <p key={level.expressId} className="text-xs text-foreground" hidden={!picked.has(level.expressId)}>{t('storeyManager.copy.level', { storey: level.name, elevation: formatStoreyElevation(level.elevation) })}</p> : <Checkbox key={level.expressId} disabled={denial !== null || progress !== null} checked={picked.has(level.expressId)} label={t('storeyManager.copy.level', { storey: level.name, elevation: formatStoreyElevation(level.elevation) })} onCheckedChange={checked => setPicked(current => { const next = new Set(current); if (checked) next.add(level.expressId); else next.delete(level.expressId); return next; })} />)}
      </div>
      {busy && <output className="flex items-center gap-2 text-xs" aria-live="polite"><Spinner className="h-3.5 w-3.5" />{t('storeyManager.copy.working')}</output>}
      {progress !== null && !busy && <output className="text-xs" aria-live="polite">{t(ready ? 'storeyManager.copy.ready' : 'storeyManager.copy.progress', { count: picked.size, progress: progress ?? 0, elements: selection.ids.length * picked.size, source: copySourceSummary(selection.modelId, selection.ids, t), targets: t('storeyManager.copy.targets', { count: picked.size }), result: t('storeyManager.copy.newElements', { count: selection.ids.length * picked.size }) })}</output>}
      <div className="flex gap-2">
        <Button size="sm" disabled={denial !== null || !picked.size || busy || (progress !== null && !ready)} onClick={() => { if (ready) void commit(); else void prepare(); }}>{t(ready ? 'storeyManager.copy.commit' : 'storeyManager.copy.prepare')}</Button>
        {progress !== null && <Button size="sm" variant="ghost" disabled={busy} onClick={cancel}>{t('storeyManager.copy.cancel')}</Button>}
      </div>
    </>}
  </div>;
}
