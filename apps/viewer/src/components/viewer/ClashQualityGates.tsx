/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useMemo, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { analysisStampOf, useAnalysisStaleness } from '@/hooks/useAnalysisStaleness';
import { newQualityBand, displayQualityPercent, evaluateQualityGates, isQualityGateConfig, qualityBand, type QualityGateConfig, type QualityGateRow, type QualityGateSnapshot } from '@/lib/clash/quality-gate';
import { runRequestOf } from '@/lib/clash/run-request';
import { useQualityGatePreferences } from '@/lib/clash/quality-gate-preferences';

export function QualityGateCards({ snapshot, models }: { snapshot: QualityGateSnapshot; models: readonly { id: string; name: string }[] }) {
  const { t } = useTranslation();
  return <div className="space-y-2" aria-label={t('clashQuality.title')}>
    {snapshot.rows.map((row, index) => {
      const band = row.percent === null ? null : qualityBand(row.percent, snapshot.config[row.kind]);
      return <div key={`${row.rule}-${index}`} className="flex items-center gap-3 rounded border border-border p-2" data-quality-rule={row.rule}>
        {/* Inline SVG keeps the ring and percentage accessible as one named image. */}
        {/* eslint-disable-next-line jsx-a11y/prefer-tag-over-role */}
        <svg width="68" height="68" viewBox="0 0 68 68" role="img" aria-label={row.percent === null ? t(`clashQuality.${row.status as Exclude<QualityGateRow['status'], 'evaluated'>}`) : `${displayQualityPercent(row.percent, snapshot.config[row.kind])}% ${band?.label}`}>
          <circle cx="34" cy="34" r="27" fill="none" stroke="currentColor" className="text-muted" strokeWidth="6" />
          {band && <circle cx="34" cy="34" r="27" fill="none" stroke={band.color} strokeWidth="6" pathLength="100"
            strokeDasharray={`${row.percent} 100`} transform="rotate(-90 34 34)" />}
          <text x="34" y="38" textAnchor="middle" fill="currentColor" fontSize="12">{row.percent === null ? '—' : `${displayQualityPercent(row.percent, snapshot.config[row.kind])}%`}</text>
        </svg>
        <div className="min-w-0 text-xs">
          <div className="font-medium break-words">{row.name}</div>
          <div className="font-medium">{band?.label ?? t(`clashQuality.${row.status as Exclude<QualityGateRow['status'], 'evaluated'>}`)}</div>
          <div>{t('clashQuality.counts', { checked: row.checked ?? '—', affected: row.affected ?? '—' })}</div>
          <div className="break-words text-muted-foreground">{t('clashQuality.models', { models: row.models.map(id => models.find(model => model.id === id)?.name ?? id).join(', ') || '—' })}</div>
          <div className="text-muted-foreground">{t('clashQuality.tolerance', { tolerance: row.tolerance })}
            {row.clearance !== undefined && ` · ${t('clashQuality.clearance', { clearance: row.clearance })}`}</div>
          <div className="text-muted-foreground">{t('clashQuality.detectionExclusions', { value: row.excludeVoidsAndHosts ? t('clashQuality.enabled') : t('clashQuality.disabled') })}</div>
        </div>
      </div>;
    })}
  </div>;
}

function QualityGateEditor() {
  const { t } = useTranslation();
  const config = useQualityGatePreferences(s => s.config);
  const save = useQualityGatePreferences(s => s.save);
  const [draft, setDraft] = useState<QualityGateConfig>(() => structuredClone(config));
  useEffect(() => setDraft(structuredClone(config)), [config]);
  const valid = isQualityGateConfig(draft);
  return <details className="text-xs">
    <summary className="cursor-pointer">{t('clashQuality.configure')}</summary>
    <div className="space-y-3 py-2">
      {(['clash', 'duplicates'] as const).map(kind => <fieldset key={kind} className="space-y-1">
        <legend className="font-medium">{t(`clashQuality.${kind}`)}</legend>
        {draft[kind].map((band, index) => <div key={index} className="flex items-center gap-1">
          <Input type="number" min="0" max="100" step="any" disabled={index === 0} className="h-7 w-16 p-1 text-xs"
            aria-label={`${t(`clashQuality.${kind}`)} ${t('clashQuality.minimum')} ${index + 1}`} value={Number.isNaN(band.minimum) ? '' : band.minimum}
            onChange={event => setDraft({ ...draft, [kind]: draft[kind].map((entry, i) => i === index ? { ...entry, minimum: event.target.valueAsNumber } : entry) })} />
          <Input className="h-7 min-w-0 flex-1 p-1 text-xs" aria-label={`${t(`clashQuality.${kind}`)} ${t('clashQuality.label')} ${index + 1}`}
            maxLength={100} value={band.label} onChange={event => setDraft({ ...draft, [kind]: draft[kind].map((entry, i) => i === index ? { ...entry, label: event.target.value } : entry) })} />
          <Input type="color" className="h-7 w-8 p-0" aria-label={`${t(`clashQuality.${kind}`)} ${t('clashQuality.color')} ${index + 1}`} value={band.color}
            onChange={event => setDraft({ ...draft, [kind]: draft[kind].map((entry, i) => i === index ? { ...entry, color: event.target.value } : entry) })} />
          {index > 0 && <IconButton type="button" variant="ghost" size="icon-xs" label={`${t('clashQuality.remove')} ${index + 1}`} onClick={() => setDraft({ ...draft, [kind]: draft[kind].filter((_, i) => i !== index) })}>×</IconButton>}
        </div>)}
        <Button type="button" variant="ghost" size="sm" disabled={draft[kind].length >= 12 || draft[kind].at(-1)!.minimum >= 100}
          onClick={() => setDraft({ ...draft, [kind]: [...draft[kind], newQualityBand(Math.min(100, draft[kind].at(-1)!.minimum + 1), t('clashQuality.newCategory'))] })}>{t('clashQuality.add')}</Button>
      </fieldset>)}
      {!valid && <p role="alert">{t('clashQuality.invalid')}</p>}
      <Button type="button" variant="outline" size="sm" disabled={!valid} onClick={() => {
        if (save(draft)) toast.success(t('clashQuality.saved')); else toast.error(t('clashQuality.failed'));
      }}>{t('clashQuality.save')}</Button>
    </div>
  </details>;
}

export function ClashQualityGates() {
  const { t } = useTranslation();
  const result = useViewerStore(s => s.clashRawResult);
  const running = useViewerStore(s => s.clashRunning);
  const models = useViewerStore(s => s.models);
  const config = useQualityGatePreferences(s => s.config);
  const stale = useAnalysisStaleness(analysisStampOf(result));
  const rows = useMemo(() => result ? evaluateQualityGates(result, stale || running, runRequestOf(result)?.kind === 'duplicates' ? 'duplicates' : 'clash') : [], [result, stale, running]);
  return <section className="space-y-2 border-b border-border px-3 py-2">
    <h3 className="text-xs font-medium">{t('clashQuality.title')}</h3>
    <QualityGateEditor />
    {result && <>
      <p className="text-2xs text-muted-foreground">{t('clashQuality.metric')}</p>
      <QualityGateCards snapshot={{ version: 1, config, rows }} models={[...models.values()]} />
      <details className="text-2xs text-muted-foreground"><summary>{t('clashQuality.metric')}</summary>{t('clashQuality.policy')}</details>
    </>}
  </section>;
}
