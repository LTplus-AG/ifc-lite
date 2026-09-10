/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { canResumeAssignmentReview, rememberAssignmentReview, forgetAssignmentReview } from '@/lib/appearance/assignments/session-review.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download.js';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import { createAppearancePlanner } from '@/lib/appearance/planner-worker-client.js';
import { captureAppearanceAssignment, type CapturedAssignment } from '@/lib/appearance/assignments/capture.js';
import { prepareAppearanceAssignments } from '@/lib/appearance/assignments/prepare.js';
import { stageAppearanceAssignments } from '@/lib/appearance/assignments/preview.js';
import { resolveAppearanceAssignments } from '@/lib/appearance/assignments/resolve.js';
import { reviewRestoredAssignment } from '@/lib/appearance/assignments/restore.js';
import { parseAppearanceAssignments, serializeAppearanceAssignments } from '@/lib/appearance/assignments/persistence.js';
import type { AppearanceAssignment } from '@/lib/appearance/assignments/types.js';
import { commitAppearanceAssignments } from '@/lib/appearance/coordinated-command.js';
import { AppearancePreviewSession } from '@/lib/appearance/preview.js';
import type { AppearanceAssetOwner } from '@/lib/appearance/assets.js';
import type { AppearancePanelViewProps } from './types.js';

type Prepared = Awaited<ReturnType<typeof prepareAppearanceAssignments>>;
type Preview = ReturnType<typeof stageAppearanceAssignments>;
type Review = Awaited<ReturnType<typeof reviewRestoredAssignment>>;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Stored recipes are inert. Only this mounted controller holds guarded live
 * snapshots, and restored rows require explicit membership review. */
export function useAppearanceAssignments(base: AppearancePanelViewProps, enabled: boolean) {
  const recipe = useViewerStore(state => state.appearanceAssignments);
  const models = useViewerStore(state => state.models), revision = useViewerStore(state => state.mutationVersion);
  const sources = useViewerStore(state => state.appearanceSources), room = useViewerStore(state => state.collabRoomId);
  const rows = useMemo(() => recipe?.assignments ?? [], [recipe]);
  const live = useRef(new Map<string, CapturedAssignment>());
  const worker = useRef<ReturnType<typeof createAppearancePlanner> | null>(null);
  const pending = useRef<AbortController | null>(null), mounted = useRef(true);
  const draft = useRef<{ preparation: Prepared; preview: Preview; owner: AppearanceAssetOwner } | null>(null);
  const [status, setStatus] = useState<AppearancePanelViewProps['status']>('idle');
  const [notice, setNotice] = useState('Add scopes to apply several images or models together.');
  const [original, setOriginal] = useState(false);
  const [review, setReview] = useState<Review[] | null>(null);
  const [bindings, setBindings] = useState(new Map<string, { modelId: string; sourceId: string }>());
  const [version, setVersion] = useState(0);
  const busy = status === 'preparing' || status === 'applying';
  function releasePreview() {
    const current = draft.current; draft.current = null;
    if (current) try { current.preview.session.cancel(); } finally { appearanceAssets.releaseOwner(current.owner); }
    setOriginal(false);
  }
  function cancel() {
    pending.current?.abort(); pending.current = null; worker.current?.cancel(); releasePreview();
    setStatus('idle'); setNotice('Preview cancelled. Your assignments are retained.');
  }
  useEffect(() => {
    mounted.current = true; worker.current = createAppearancePlanner();
    return () => { mounted.current = false; pending.current?.abort(); worker.current?.dispose(); worker.current = null;
      const current = draft.current; draft.current = null;
      if (current) try { current.preview.session.cancel(); } finally { appearanceAssets.releaseOwner(current.owner); }
    };
  }, []);
  useEffect(() => {
    const resumable = rows.filter(row => !live.current.has(row.id) && canResumeAssignmentReview(row));
    if (!enabled || !resumable.length) return;
    void run(async signal => {
      if (!worker.current) return;
      for (const row of resumable) {
        const result = await reviewRestoredAssignment({ saved: row, modelId: row.model.modelId,
          sourceId: row.source.id, planner: worker.current, signal });
        signal.throwIfAborted();
        if (!canResumeAssignmentReview(row) || result.sourceModelChanged || result.changes.added.length
          || result.changes.removed.length || result.changes.renumbered.length || result.removedExclusions.length) continue;
        live.current.set(row.id, result.proposed); rememberAssignmentReview(result.proposed);
      }
      if (mounted.current) { setVersion(v => v + 1); setStatus('idle'); setNotice('Unchanged reviewed scopes restored. Preview all assignments to continue.'); }
    });
  }, [enabled]);
  useEffect(() => { if (!enabled) cancel(); }, [enabled]);
  useEffect(() => {
    if (!rows.length || status === 'applying') return;
    try {
      if (room) throw new Error('Leave the shared room before editing assignments.');
      const stale: string[] = [];
      for (const row of rows) {
        try { live.current.get(row.id)?.validate(); }
        catch (error) { live.current.delete(row.id); stale.push(message(error)); }
      }
      if (stale.length) { setVersion(v => v + 1); throw new Error(stale[0]); }
      draft.current?.preparation.validate();
    } catch (error) { releasePreview(); setStatus('stale'); setNotice(`${message(error)} Review the affected assignments before previewing again.`); }
  }, [models, revision, sources, room]);

  function save(next: AppearanceAssignment[]) {
    if (next.length) resolveAppearanceAssignments(next);
    releasePreview(); setReview(null);
    useViewerStore.getState().saveAppearanceAssignments(next.length ? { version: 1, assignments: next } : null);
    setStatus('idle'); setNotice('Assignments changed. Preview all assignments to review the result.');
  }
  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    pending.current?.abort(); worker.current?.cancel();
    const controller = new AbortController(); pending.current = controller;
    setStatus('preparing');
    try { await operation(controller.signal); }
    catch (error) { if (!controller.signal.aborted && mounted.current) { setStatus('error'); setNotice(message(error)); } }
    finally { if (pending.current === controller) pending.current = null; }
  }
  function add() {
    base.onDiscard(); releasePreview();
    void run(async signal => {
      if (!base.modelId || !base.sourceId || !worker.current) throw new Error('Choose a model, source and scope first.');
      const previous = rows.find(row => row.model.modelId === base.modelId);
      const captured = await captureAppearanceAssignment({ modelId: base.modelId, sourceId: base.sourceId,
        slotId: previous?.model.slotId ?? crypto.randomUUID(), scope: base.scope, settings: base.settings,
        planner: worker.current, signal, previousSnapshot: previous ? live.current.get(previous.id)?.snapshot : undefined });
      signal.throwIfAborted(); if (!mounted.current) return;
      save([...rows, captured.assignment]); live.current.set(captured.assignment.id, captured); rememberAssignmentReview(captured); setVersion(v => v + 1);
    });
  }
  function change(id: string, edit: (row: AppearanceAssignment) => AppearanceAssignment) {
    if (busy) return;
    const next = rows.map(row => row.id === id ? edit(structuredClone(row)) : row);
    const previous = live.current.get(id), changed = next.find(row => row.id === id);
    save(next); if (previous && changed) { const updated = { ...previous, assignment: changed }; live.current.set(id, updated); rememberAssignmentReview(updated); }
  }
  function previewAll() {
    releasePreview();
    void run(async signal => {
      const planner = worker.current, renderer = getGlobalRenderer();
      if (!planner || !renderer) throw new Error('The appearance renderer is not ready.');
      const captured = rows.map(row => {
        const bound = live.current.get(row.id);
        if (!bound) throw new Error(`Review and bind ${row.model.name} / ${row.source.name} before previewing.`);
        bound.validate(); return { ...bound, assignment: row };
      });
      const owner: AppearanceAssetOwner = { kind: 'draft', id: crypto.randomUUID() };
      let adopted = false;
      try {
        const preparation = await prepareAppearanceAssignments({ captured, planner, owner, signal,
          onProgress: (done, total) => { if (mounted.current) setNotice(`Preparing assignment ${done} of ${total}…`); } });
        signal.throwIfAborted(); if (!mounted.current) return;
        const preview = stageAppearanceAssignments(preparation, captured, renderer);
        draft.current = { preparation, preview, owner }; adopted = true;
        const converted = preparation.steps.reduce((sum, step) => sum + (step.plan.conversions?.length ?? 0), 0);
        setStatus('ready'); setNotice(`Preview ready across ${preparation.snapshots.size} models.${converted ? ` ${converted} objects will become mesh geometry.` : ''} Apply saves all assignments together.`);
      } finally { if (!adopted) appearanceAssets.releaseOwner(owner); }
    });
  }
  function compare(showOriginal: boolean) {
    const current = draft.current, renderer = getGlobalRenderer(); if (!current || !renderer) return;
    try {
      current.preparation.validate();
      if (showOriginal) current.preview.session.cancel();
      else { const session = new AppearancePreviewSession(renderer); session.stage([...current.preview.groups.values()].flat()); current.preview.session = session; }
      setOriginal(showOriginal);
    } catch (error) { releasePreview(); setStatus('stale'); setNotice(message(error)); }
  }
  async function apply() {
    const current = draft.current, renderer = getGlobalRenderer();
    if (!current || !renderer || original || status !== 'ready') return;
    const controller = new AbortController(); pending.current = controller; setStatus('applying');
    try {
      const result = await commitAppearanceAssignments(current.preparation, renderer, current.preview.session, current.preview.groups,
        { signal: controller.signal, onProgress: phase => { if (mounted.current) setNotice(phase === 'preparing' ? 'Preparing all IFC changes…' : 'Saving coordinated appearance…'); } });
      draft.current = null; appearanceAssets.releaseOwner(current.owner); live.current.clear(); rows.forEach(forgetAssignmentReview);
      if (mounted.current) { setStatus('idle'); setVersion(v => v + 1); setNotice(result.observerFailed ? 'All assignments applied and Undo is available. A viewer observer failed; refresh the panel before continuing.' : 'All assignments applied. One Undo restores every model. Review the saved scopes before another application.'); }
    } catch (error) { releasePreview(); if (mounted.current) { setStatus('error'); setNotice(message(error)); } }
    finally { if (pending.current === controller) pending.current = null; }
  }
  function binding(row: AppearanceAssignment) { return bindings.get(row.id) ?? { modelId: row.model.modelId, sourceId: row.source.id }; }
  function setBinding(id: string, patch: { modelId?: string; sourceId?: string }) {
    if (busy) return;
    const row = rows.find(item => item.id === id); if (!row) return;
    setReview(null);
    setBindings(current => {
      const next = new Map(current);
      for (const item of rows) {
        const previous = current.get(item.id) ?? { modelId: item.model.modelId, sourceId: item.source.id };
        if (patch.modelId !== undefined && item.model.slotId === row.model.slotId) next.set(item.id, { ...previous, modelId: patch.modelId });
      }
      if (patch.sourceId !== undefined) next.set(id, { ...(next.get(id) ?? binding(row)), sourceId: patch.sourceId });
      return next;
    });
  }
  function canReview(id: string) {
    const row = rows.find(item => item.id === id); if (!row) return false;
    return rows.filter(item => item.model.slotId === row.model.slotId).every(item => {
      const chosen = binding(item); return models.has(chosen.modelId) && sources.some(source => source.id === chosen.sourceId);
    });
  }
  function reviewRow(id: string) {
    releasePreview(); setReview(null);
    void run(async signal => {
      const saved = rows.find(row => row.id === id); if (!saved || !worker.current) return;
      const modelId = binding(saved).modelId;
      const proposed: Review[] = [];
      // A model revision is one binding: refresh all its rows together, while
      // preserving every original source and presenting each membership delta.
      for (const row of rows.filter(item => item.model.slotId === saved.model.slotId)) {
        proposed.push(await reviewRestoredAssignment({ saved: row, modelId,
          sourceId: binding(row).sourceId, planner: worker.current, signal }));
      }
      signal.throwIfAborted(); if (!mounted.current) return;
      setReview(proposed); setStatus('idle'); setNotice('Review the membership differences, then accept this scope explicitly.');
    });
  }
  function acceptReview() {
    if (!review) return;
    try {
      for (const item of review) item.proposed.validate();
      const reviewed = new Map(review.map(item => [item.proposed.assignment.id, item.proposed]));
      save(rows.map(row => reviewed.get(row.id)?.assignment ?? row));
      for (const [id, proposed] of reviewed) { live.current.set(id, proposed); rememberAssignmentReview(proposed); }
      setVersion(v => v + 1);
    } catch (error) { setStatus('error'); setNotice(message(error)); }
  }
  function restore(file: File) {
    if (file.size > 4 * 1024 * 1024) { setStatus('error'); setNotice('The assignment recipe exceeds 4 MiB.'); return; }
    void run(async signal => {
      const restored = parseAppearanceAssignments(await file.text()); signal.throwIfAborted();
      if (!mounted.current) return;
      rows.forEach(forgetAssignmentReview); restored.assignments.forEach(forgetAssignmentReview);
      save(restored.assignments); setBindings(new Map()); live.current.clear(); setVersion(v => v + 1);
      setNotice('Recipe restored. Choose each loaded model and original source, then review its membership.');
    });
  }
  function download() {
    try {
      downloadBlob(new Blob([serializeAppearanceAssignments(rows)], { type: 'application/json' }),
        `${sanitizeFilename('appearance-assignments')}.json`);
    } catch (error) { setStatus('error'); setNotice(message(error)); }
  }
  const resolved = useMemo(() => rows.length ? resolveAppearanceAssignments(rows) : [], [rows]);
  return { rows, busy, status, notice, original, review, version, resolved, add, change, previewAll, compare, apply, cancel,
    reviewRow, acceptReview, restore, download, binding, setBinding, canReview,
    bound(id: string) { return live.current.has(id); },
    remove(id: string) { const row = rows.find(row => row.id === id); if (row) forgetAssignmentReview(row); save(rows.filter(row => row.id !== id)); live.current.delete(id); },
    move(id: string, direction: -1 | 1) { const next = [...rows], index = next.findIndex(row => row.id === id), target = index + direction;
      if (index >= 0 && target >= 0 && target < next.length) { [next[index], next[target]] = [next[target], next[index]]; save(next); } },
    hasPreview: !!draft.current,
    blockedReason: room ? 'Leave the shared room before editing assignments.' : undefined,
    affectedCount: resolved.reduce((sum, row) => sum + row.productIds.length, 0),
  };
}
