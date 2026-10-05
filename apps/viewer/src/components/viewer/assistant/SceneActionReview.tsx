/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { Eye, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { useAssistant } from '@/lib/assistant/conversation';
import type { EvidenceSnapshot } from '@/lib/assistant/evidence';
import { parseSceneActions, type SceneActionSet } from '@/lib/actions/scene-actions';
import { previewSceneActions, unresolvedCount, type ActionPreview } from '@/lib/actions/scene-preview';
import { applySceneActions, type ApplyResult } from '@/lib/actions/scene-apply';
import { restoreSceneApplication } from '@/lib/actions/scene-restore';
import { useSceneSession, type RestoreReport } from '@/lib/actions/scene-session';

const num = (value: number) => String(Number(value.toFixed(3)));

function ActionLine({ preview }: { preview: ActionPreview }) {
  const { t } = useTranslation();
  const { action, counts } = preview;
  const details: string[] = [];
  if (action.type === 'section') {
    details.push('plane' in action
      ? t('sceneActions.plane', { x: num(action.plane.origin[0]), y: num(action.plane.origin[1]), z: num(action.plane.origin[2]),
        nx: num(action.plane.normal[0]), ny: num(action.plane.normal[1]), nz: num(action.plane.normal[2]), units: action.units })
      : t('sceneActions.box', { x1: num(action.box.min[0]), y1: num(action.box.min[1]), z1: num(action.box.min[2]),
        x2: num(action.box.max[0]), y2: num(action.box.max[1]), z2: num(action.box.max[2]), units: action.units }));
  } else if (action.type === 'camera') {
    details.push(t('sceneActions.cameraAt', { x1: num(action.eye[0]), y1: num(action.eye[1]), z1: num(action.eye[2]),
      x2: num(action.target[0]), y2: num(action.target[1]), z2: num(action.target[2]), units: action.units }));
  } else {
    if (preview.status === 'ready') details.push(t('sceneActions.elements', { count: preview.ids.length }));
    const stale = counts['stale-citation'];
    const unresolved = unresolvedCount(counts) - stale;
    if (unresolved) details.push(t('sceneActions.unresolved', { count: unresolved }));
    if (stale) details.push(t('sceneActions.stale', { count: stale }));
    if (preview.hiddenTargets) details.push(t('sceneActions.hiddenStay', { count: preview.hiddenTargets }));
    if (preview.overlapping) details.push(t('sceneActions.overlapping', { count: preview.overlapping }));
  }
  const refusal = preview.reason === 'no-targets' ? 'sceneActions.refusedNoTargets'
    : preview.reason === 'no-bounds' ? 'sceneActions.refusedNoBounds' : 'sceneActions.refusedOutside';
  return <li className={preview.status === 'refused' ? 'rounded border border-amber-500/40 bg-amber-500/10 p-1.5' : 'p-1.5'}>
    <p><span className="font-semibold">{t(`sceneActions.${action.type}`)}</span> · {details.join(' · ')}</p>
    {preview.groups && <ul className="mt-1 space-y-0.5">{preview.groups.map(group => <li key={group.colour} className="flex items-center gap-1.5">
      <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-border"
        style={{ backgroundColor: `rgb(${group.rgba.slice(0, 3).map(c => Math.round(c * 255)).join(' ')})` }} />
      <span className="min-w-0 break-words">{group.label}</span>
      <span className="text-muted-foreground">{group.colour} · {t('sceneActions.elements', { count: group.ids.length })}</span>
    </li>)}</ul>}
    {preview.status === 'refused' && <p className="mt-0.5">{t(refusal)}</p>}
  </li>;
}

function AppliedNote({ result }: { result: ApplyResult }) {
  const { t } = useTranslation();
  return <output className="block rounded bg-muted/50 p-2 space-y-0.5">
    <span className="block font-semibold">{t('sceneActions.applied')}</span>
    <span className="block">{result.applied.map(({ type, count }) => count ? t('sceneActions.appliedCount', { action: t(`sceneActions.${type}`), count }) : t(`sceneActions.${type}`)).join(' · ')}</span>
    {result.unavailable.length > 0 && <span className="block">{t('sceneActions.unavailable', { actions: result.unavailable.map(type => t(`sceneActions.${type}`)).join(', ') })}</span>}
  </output>;
}

function RestoreNote({ report }: { report: RestoreReport }) {
  const { t } = useTranslation();
  if (report.channels.some(channel => channel.outcome === 'models-changed')) {
    return <output className="block rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('sceneActions.modelsChanged')}</output>;
  }
  const kept = report.channels.filter(channel => channel.outcome !== 'restored');
  return <output className="block rounded bg-muted/50 p-2 space-y-0.5">
    <span className="block font-semibold">{t('sceneActions.restored')}</span>
    {kept.length > 0 && <span className="block">{t('sceneActions.notRestored', { channels: kept.map(({ channel }) => t(`sceneActions.channel.${channel}`)).join(', ') })}</span>}
  </output>;
}

function SceneActionCard({ set, evidence }: { set: SceneActionSet; evidence: EvidenceSnapshot | null }) {
  const { t } = useTranslation();
  // Resolution reads models, edits, visibility and evidence freshness: re-preview on any store change.
  const state = useViewerStore(s => s);
  const preview = useMemo(() => previewSceneActions(state, set, evidence), [state, set, evidence]);
  const active = useSceneSession(s => s.active);
  const [result, setResult] = useState<{ applied: ApplyResult; id: string | null } | null>(null);
  const ours = result?.id != null && active?.id === result.id;
  const apply = () => {
    const applied = applySceneActions(set, evidence);
    setResult(applied ? { applied, id: useSceneSession.getState().active?.id ?? null } : null);
  };
  return <section aria-label={t('sceneActions.review')} className="mx-3 my-2 rounded border border-border text-xs">
    <h3 className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 font-semibold">
      <Eye className="h-3.5 w-3.5 text-primary" aria-hidden="true" /><span className="min-w-0 break-words">{set.title}</span>
    </h3>
    <div className="p-2 space-y-2">
      {set.rationale && <p className="whitespace-pre-wrap break-words">{set.rationale}</p>}
      <p className="text-muted-foreground">{t('sceneActions.inert')}</p>
      <ul className="space-y-1">{preview.actions.map(action => <ActionLine key={action.index} preview={action} />)}</ul>
      {preview.ready === 0 && <p role="note" className="text-muted-foreground">{t('sceneActions.nothingReady')}</p>}
      {result && ours && <AppliedNote result={result.applied} />}
      <Button size="sm" className="h-7" disabled={preview.ready === 0 || ours} onClick={apply}>
        {t('sceneActions.apply', { count: preview.ready })}
      </Button>
    </div>
  </section>;
}

/**
 * The restore point outlives the proposal card: a later question replaces the
 * card, but "Restore previous view" stays offered until it is used.
 */
export function SceneRestoreBar() {
  const { t } = useTranslation();
  const { active, lastRestore } = useSceneSession();
  if (!active && !lastRestore) return null;
  return <div className="mx-3 my-2 space-y-1 text-xs">
    {lastRestore && !active && <RestoreNote report={lastRestore} />}
    {active && <div className="flex items-center gap-2 rounded border border-primary/30 bg-primary/5 p-2">
      <span className="min-w-0 flex-1 break-words">{t('sceneActions.activeTitle', { title: active.title })}</span>
      <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={() => restoreSceneApplication(active)}>
        <RotateCcw className="h-3 w-3 mr-1" aria-hidden="true" />{t('sceneActions.restore')}
      </Button>
    </div>}
  </div>;
}

/** The latest completed `scene.actions` answer, reviewed natively below the conversation. */
export function SceneActionReview() {
  const assistant = useAssistant();
  const reply = assistant.messages.at(-1);
  const content = reply?.role === 'assistant' && assistant.status !== 'streaming' ? reply.content : null;
  const set = useMemo((): SceneActionSet | null => {
    if (!content || !/"kind"\s*:\s*"scene\.actions"/.test(content)) return null;
    try { return parseSceneActions(content); }
    catch (error) {
      // The conversation shows the refusal reason on the proposal card.
      console.warn('[Assistant] Scene action proposal is not reviewable', error);
      return null;
    }
  }, [content]);
  if (!set) return null;
  // Keyed by answer so a newer proposal starts a fresh review; archived conversations have no live evidence.
  return <SceneActionCard key={`${assistant.snapshot?.id ?? 'archived'}:${assistant.messages.length}`} set={set} evidence={assistant.snapshot} />;
}
