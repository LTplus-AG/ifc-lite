/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { panelTitleKey } from '@/lib/panels/registry';
import type { SavedConversation } from '@/lib/assistant/persistence';
import type { AssistantSource } from '@/lib/assistant/sources';

type PortableEvidence = SavedConversation['evidence'];
const ROW_MEANING: Record<AssistantSource, TranslationKey> = {
  clash: 'assistant.evidenceRowsClash', validation: 'assistant.evidenceRowsValidation',
  compare: 'assistant.evidenceRowsCompare', flow: 'assistant.evidenceRowsFlow', loadReport: 'assistant.evidenceRowsLoadReport',
};
const UNAVAILABLE: Record<AssistantSource, TranslationKey> = {
  clash: 'assistant.evidenceUnavailableClash', validation: 'assistant.evidenceUnavailableValidation',
  compare: 'assistant.evidenceUnavailableCompare', flow: 'assistant.evidenceUnavailableFlow',
  loadReport: 'assistant.evidenceUnavailableLoadReport',
};
function sourceAvailability(payload: string): 'available' | 'unavailable' | 'unknown' {
  if (payload.length > 48_000) return 'unknown';
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('sourceAvailability' in parsed)) return 'unknown';
    return parsed.sourceAvailability === 'available' || parsed.sourceAvailability === 'unavailable' ? parsed.sourceAvailability : 'unknown';
  } catch (error) {
    console.warn('[Evidence view] Cannot read source availability', error);
    return 'unknown';
  }
}
interface ModelMetadata { id: string; name: string; fingerprint?: string }

function capturedModels(payload: string): { models: ModelMetadata[]; total: number; omitted: boolean } | null {
  if (payload.length > 48_000) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(payload); }
  catch (error) { console.warn('[Evidence view] Invalid captured JSON', error); return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(envelope.totalModels) || Number(envelope.totalModels) < 0 || !Array.isArray(envelope.models)
    || envelope.models.length > 100 || envelope.models.length > Number(envelope.totalModels)) return null;
  const models: ModelMetadata[] = [];
  for (const value of envelope.models) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const model = value as Record<string, unknown>;
    if (typeof model.id !== 'string' || !model.id || model.id.length > 1200
      || typeof model.name !== 'string' || model.name.length > 1200
      || (model.fingerprint !== undefined && typeof model.fingerprint !== 'string')) return null;
    models.push({ id: model.id, name: model.name, ...(typeof model.fingerprint === 'string' ? { fingerprint: model.fingerprint } : {}) });
  }
  return { models, total: Number(envelope.totalModels), omitted: envelope.modelMetadataTruncated === true || models.length < Number(envelope.totalModels) };
}

/** Presentation only: caller owns freshness/review; JSON never grants an effect. */
export function EvidenceView({ evidence, state }: {
  evidence: PortableEvidence;
  state: 'captured' | 'stale' | 'historical';
}) {
  const { t } = useTranslation();
  const availability = useMemo(() => sourceAvailability(evidence.payload), [evidence.payload]);
  const metadata = useMemo(() => capturedModels(evidence.payload), [evidence.payload]);
  return <section aria-label={t('assistant.evidenceContext')} className="space-y-2 rounded border border-border p-2 text-xs">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="font-semibold">{t(panelTitleKey(evidence.source))}</span>
      <span className="text-muted-foreground">{t(state === 'historical' ? 'assistant.evidenceHistorical' : state === 'stale'
        ? 'assistant.evidenceStale' : 'assistant.evidenceCaptured')}</span>
    </div>
    {availability === 'unavailable' ? <p>{t(UNAVAILABLE[evidence.source])}</p> : <>
      {availability === 'unknown' && <p>{t('assistant.evidenceAvailabilityUnknown')}</p>}
      {availability === 'available' && evidence.totalRows === 0
        ? <p>{t('assistant.evidenceEmpty')}</p>
        : <p>{t('assistant.scope', { included: evidence.includedRows, total: evidence.totalRows })}</p>}
    </>}
    <p className="text-muted-foreground">{t(ROW_MEANING[evidence.source])}</p>
    {evidence.includedRows < evidence.totalRows && <p className="text-muted-foreground">{t('assistant.evidenceSample')}</p>}
    {evidence.projectionTruncated && <p className="text-muted-foreground">{t('assistant.evidenceTruncated')}</p>}
    <time className="block text-2xs text-muted-foreground" dateTime={evidence.capturedAt}>{evidence.capturedAt}</time>
    {metadata ? <details>
      <summary className="cursor-pointer">{t('assistant.evidenceModels', { included: metadata.models.length, total: metadata.total })}</summary>
      <p className="text-muted-foreground">{t('assistant.evidenceModelScope')}</p>
      {metadata.omitted && <p className="text-muted-foreground">{t('assistant.evidenceModelsOmitted')}</p>}
      <ul className="space-y-1 max-h-40 overflow-auto">
        {metadata.models.map((model, index) => <li key={`${model.id}:${index}`} className="break-words">
          <span>{model.name}</span> <span className="font-mono">({model.id})</span>
          {model.fingerprint && <span className="block font-mono text-2xs">{model.fingerprint}</span>}
        </li>)}
      </ul>
    </details> : <p className="text-muted-foreground">{t('assistant.evidenceModelsUnknown')}</p>}
    <details><summary className="cursor-pointer">{t('assistant.evidence')}</summary>
      <pre className="whitespace-pre-wrap break-words max-h-64 overflow-auto">{evidence.payload}</pre>
    </details>
  </section>;
}
