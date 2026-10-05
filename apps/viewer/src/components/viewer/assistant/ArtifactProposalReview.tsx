/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review of the latest `filter.proposal`, `list.proposal`, `lens.proposal` or
 * `chart.proposal` answer (viewer AI P13). Names are checked against the
 * loaded models first; an unresolved one waits for the user's pick. Then the
 * proposal runs through its own native engine and the card shows exactly what
 * that engine returned. Saving writes the native library entry and opens the
 * native panel on it; nothing changes the scene.
 */

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ClipboardCheck, ExternalLink, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { useAssistant } from '@/lib/assistant/conversation';
import { declaredArtifactKind, parseArtifactProposal, type ArtifactProposal } from '@/lib/assistant/artifacts/proposal-kinds';
import { fieldSites } from '@/lib/assistant/artifacts/field-refs';
import { resolveFields, type FieldResolution } from '@/lib/assistant/artifacts/field-candidates';
import { modelSchemaIndex, type ModelSchemaIndex } from '@/lib/assistant/artifacts/model-schema';
import { isPreviewCurrent, previewArtifact, type ArtifactPreview } from '@/lib/assistant/artifacts/artifact-preview';
import { openFilterInSearch, openSavedArtifact, saveArtifact, type SavedArtifact } from '@/lib/assistant/artifacts/artifact-save';
import { ArtifactAmbiguity } from './ArtifactAmbiguity';
import { ArtifactPreviewView } from './ArtifactPreviewView';

const SAVE_LABEL: Record<ArtifactProposal['kind'], TranslationKey> = {
  'filter.proposal': 'assistantArtifacts.saveFilter', 'list.proposal': 'assistantArtifacts.saveList',
  'lens.proposal': 'assistantArtifacts.saveLens', 'chart.proposal': 'assistantArtifacts.saveChart',
};
const OPEN_LABEL: Record<ArtifactProposal['kind'], TranslationKey> = {
  'filter.proposal': 'assistantArtifacts.openFilter', 'list.proposal': 'assistantArtifacts.openList',
  'lens.proposal': 'assistantArtifacts.openLens', 'chart.proposal': 'assistantArtifacts.openChart',
};

/** The latest completed artifact answer; a refused one shows its reason on the proposal card instead. */
export function ArtifactProposalReview({ onAsk }: { onAsk: ((prompt: string) => void) | null }) {
  const assistant = useAssistant();
  const reply = assistant.messages.at(-1);
  const content = reply?.role === 'assistant' && assistant.status !== 'streaming' && assistant.error !== 'truncated-output' ? reply.content : null;
  const proposal = useMemo(() => {
    const kind = content ? declaredArtifactKind(content) : null;
    if (!content || !kind) return null;
    try { return parseArtifactProposal(content, kind); }
    catch (error) {
      console.warn('[Assistant] Artifact proposal is not reviewable', error);
      return null;
    }
  }, [content]);
  if (!proposal) return null;
  // Keyed by answer so a newer proposal starts a fresh review.
  return <ArtifactReview key={`${assistant.snapshot?.id ?? assistant.archived?.id ?? 'conversation'}:${assistant.messages.length}`} initial={proposal} onAsk={onAsk} />;
}

function ArtifactReview({ initial, onAsk }: { initial: ArtifactProposal; onAsk: ((prompt: string) => void) | null }) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const [proposal, setProposal] = useState(initial);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedArtifact | null>(null);
  // The schema index is scanned in chunks; a newer federation or revision abandons the stale scan.
  const [schema, setSchema] = useState<{ index: ModelSchemaIndex | null; error: string | null; checking: boolean }>({ index: null, error: null, checking: false });
  useEffect(() => {
    if (models.size === 0) { setSchema({ index: null, error: null, checking: false }); return; }
    const controller = new AbortController();
    setSchema({ index: null, error: null, checking: true });
    modelSchemaIndex({ models, mutationViews, mutationVersion }, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setSchema({ index: next, error: null, checking: false }); })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        console.warn('[Assistant] Model schema index unavailable for review', reason);
        setSchema({ index: null, error: reason instanceof Error ? reason.message : String(reason), checking: false });
      });
    return () => controller.abort();
  }, [models, mutationViews, mutationVersion]);
  const { index, error: indexError, checking } = schema;
  const resolutions = useMemo<FieldResolution[]>(() => (index ? resolveFields(fieldSites(proposal), index) : []), [proposal, index]);
  const unresolved = resolutions.filter((resolution): resolution is Extract<FieldResolution, { status: 'unresolved' }> => resolution.status === 'unresolved');
  const blocked = !index || unresolved.length > 0;

  // The engine reruns whenever the proposal resolves or the models change, so the numbers shown are always current.
  useEffect(() => {
    if (blocked) return;
    const controller = new AbortController();
    setRunning(true);
    setError(null);
    previewArtifact(proposal, useViewerStore.getState(), controller.signal)
      .then((next) => { if (!controller.signal.aborted) setPreview(next); })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        console.warn('[Assistant] Artifact preview failed', reason);
        setPreview(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!controller.signal.aborted) setRunning(false); });
    return () => controller.abort();
  }, [proposal, blocked, index]);

  const current = !!preview && !running && isPreviewCurrent(preview, { models, mutationVersion });
  const save = () => {
    if (!preview) return;
    const outcome = saveArtifact(preview.artifact);
    if (outcome.ok) { setSaved(outcome.saved); setError(null); }
    else setError(outcome.reason);
  };
  return <section aria-label={t('assistantArtifacts.title')} className="mx-3 my-2 rounded border border-border text-xs">
    <h3 className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 font-semibold">
      <ClipboardCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />{t('assistantArtifacts.title')}
    </h3>
    <div className="p-2 space-y-2">
      <p className="font-medium break-words">{proposal.title}</p>
      {proposal.rationale && <p className="text-muted-foreground break-words">{proposal.rationale}</p>}
      {models.size === 0 && <output className="block">{t('assistantArtifacts.noModels')}</output>}
      {checking && <output className="block text-muted-foreground animate-pulse">{t('assistantArtifacts.checking')}</output>}
      {indexError && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive break-words">
        {t('assistantArtifacts.indexFailed', { reason: indexError })}</p>}
      {resolutions.some((resolution) => resolution.status === 'exact') && <ul aria-label={t('assistantArtifacts.checkedFields')} className="text-muted-foreground">
        {resolutions.flatMap((resolution, i) => resolution.status === 'exact' ? [<li key={i} className="break-words">
          {t('assistantArtifacts.checkedField', { field: `${resolution.presence.set}.${resolution.presence.name}`, count: resolution.presence.count })}
        </li>] : [])}
      </ul>}
      {unresolved.length > 0 && <ArtifactAmbiguity unresolved={unresolved} onAsk={onAsk}
        onResolve={(picks) => setProposal((currentProposal) => picks.reduce((next, { resolution, candidate }) =>
          resolution.site.replace(next, candidate.set, candidate.name), currentProposal))} />}
      {index?.partial && <p className="text-muted-foreground">{t('assistantArtifacts.partialIndex')}</p>}
      {running && <output className="block text-muted-foreground animate-pulse">{t('assistantArtifacts.running')}</output>}
      {preview && !running && <ArtifactPreviewView preview={preview} />}
      {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive break-words">{error}</p>}
      {preview && !saved && <div className="flex flex-wrap gap-2">
        <Button size="sm" className="h-7" disabled={!current} onClick={save}><Save className="h-3 w-3 mr-1" aria-hidden="true" />{t(SAVE_LABEL[proposal.kind])}</Button>
        {preview.artifact.kind === 'filter.proposal' && <Button size="sm" variant="outline" className="h-7" disabled={!current}
          onClick={() => { if (preview.artifact.kind === 'filter.proposal') openFilterInSearch(preview.artifact); }}>
          <ExternalLink className="h-3 w-3 mr-1" aria-hidden="true" />{t('assistantArtifacts.openFilterUnsaved')}
        </Button>}
      </div>}
      {saved && preview && <div aria-live="polite" className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 space-y-2">
        <p className="flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          {saved.kind === 'chart.proposal' ? t('assistantArtifacts.savedChart', { name: saved.name, dashboard: saved.dashboardName }) : t('assistantArtifacts.saved', { name: saved.name })}</p>
        <Button size="sm" variant="outline" className="h-7" onClick={() => openSavedArtifact(saved, preview.artifact)}>
          <ExternalLink className="h-3 w-3 mr-1" aria-hidden="true" />{t(OPEN_LABEL[saved.kind])}
        </Button>
      </div>}
    </div>
  </section>;
}
