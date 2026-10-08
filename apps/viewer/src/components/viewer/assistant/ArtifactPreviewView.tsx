/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The native engine's answer to an artifact proposal: population per model, denominators, legend or buckets, sample rows. */

import type { ChartSource } from '@ifc-lite/charts';
import { formatLocaleNumber, useTranslation, type TranslationKey } from '@/i18n';
import type { ArtifactPreview } from '@/lib/assistant/artifacts/artifact-preview';

const SOURCE_TITLES: Record<ChartSource, TranslationKey> = { elements: 'assistantSources.selection.title', clash: 'clashPanel.title',
  bcf: 'bcf.panel.title', schedule: 'workspacePanels.bottom.gantt', ids: 'validationPanel.title', compare: 'comparePanel.panel.title' };

export function ArtifactPreviewView({ preview }: { preview: ArtifactPreview }) {
  const { t, locale } = useTranslation();
  const number = (value: number) => formatLocaleNumber(locale, Number(value.toPrecision(6)), { maximumFractionDigits: 3 });
  const analysis = preview.rowSource !== undefined && preview.rowSource !== 'elements';
  const valued = preview.buckets.some((bucket) => bucket.value !== undefined && bucket.value !== bucket.count);
  return <div className="space-y-2">
    <p className="font-medium">{t(analysis ? 'assistantArtifacts.analysisRows' : 'assistantArtifacts.matched', { count: preview.matched })}</p>
    {analysis && <p className="text-muted-foreground">{t('assistantArtifacts.analysisSource', { source: t(SOURCE_TITLES[preview.rowSource ?? 'elements']) })}</p>}
    {analysis && preview.unlinkedRows !== undefined && preview.unlinkedRows > 0 && <p className="text-muted-foreground">{t('assistantArtifacts.analysisUnlinked', { count: preview.unlinkedRows })}</p>}
    {preview.matched === 0 && <output className="block rounded border border-amber-500/40 bg-amber-500/10 p-2">{t('assistantArtifacts.empty')}</output>}
    <ul aria-label={t(analysis ? 'assistantArtifacts.analysisPopulation' : 'assistantArtifacts.populationLabel')} className="space-y-0.5">
      {preview.population.map((model) => <li key={model.modelId} className="flex gap-2">
        <span className="min-w-0 flex-1 truncate">{model.name}</span><span className="tabular-nums">{t(analysis ? 'assistantArtifacts.analysisRows' : 'assistantArtifacts.populationCount', { count: model.count })}</span>
      </li>)}
    </ul>
    {preview.measures.map((measure) => <p key={measure.label} className="rounded bg-muted/50 p-1.5">
      {t('assistantArtifacts.measure', { label: measure.label, total: number(measure.total), unit: measure.unit ?? t('assistantArtifacts.noUnit'),
        measured: measure.measured, rows: measure.rows })}
      {measure.rows > measure.measured && <> {t('assistantArtifacts.measureMissing', { count: measure.rows - measure.measured })}</>}
    </p>)}
    {preview.unassigned !== undefined && preview.unassigned > 0 && <p className="text-muted-foreground">
      {t(analysis ? 'assistantArtifacts.analysisUnbucketed' : preview.kind === 'chart.proposal' ? 'assistantArtifacts.unbucketed' : 'assistantArtifacts.uncoloured', { count: preview.unassigned })}
    </p>}
    {preview.buckets.length > 0 && <table className="w-full text-2xs" aria-label={t(preview.kind === 'chart.proposal' ? 'assistantArtifacts.bucketsChart' : 'assistantArtifacts.bucketsLens')}>
      <thead><tr className="text-left text-muted-foreground">
        <th scope="col" className="font-normal">{t('assistantArtifacts.bucket')}</th>
        <th scope="col" className="font-normal text-right">{t(analysis ? 'assistantArtifacts.rows' : 'assistantArtifacts.elements')}</th>
        {valued && <th scope="col" className="font-normal text-right">{preview.unit ? t('assistantArtifacts.valueIn', { unit: preview.unit }) : t('assistantArtifacts.value')}</th>}
      </tr></thead>
      <tbody>{preview.buckets.slice(0, 12).map((bucket) => <tr key={bucket.label}>
        <td className="flex items-center gap-1">{bucket.color && <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: bucket.color }} />}
          <span className={bucket.absence ? 'italic' : undefined}>{bucket.label}</span></td>
        <td className="text-right tabular-nums">{bucket.count}</td>
        {valued && <td className="text-right tabular-nums">{bucket.value === undefined ? '' : number(bucket.value)}</td>}
      </tr>)}</tbody>
    </table>}
    {preview.buckets.length > 12 && <p className="text-muted-foreground">{t('assistantArtifacts.moreBuckets', { count: preview.buckets.length - 12 })}</p>}
    {preview.samples.length > 0 && <details>
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{t('assistantArtifacts.samples', { count: preview.samples.length })}</summary>
      <div className="mt-1 max-h-48 overflow-auto">
        <table className="w-full text-2xs">
          <thead><tr className="text-left text-muted-foreground">
            <th scope="col" className="font-normal">{t('assistantArtifacts.sampleModel')}</th>
            <th scope="col" className="font-normal">{t('assistantArtifacts.sampleClass')}</th>
            <th scope="col" className="font-normal">{t('assistantArtifacts.sampleName')}</th>
            {preview.sampleColumns.map((column) => <th key={column} scope="col" className="font-normal">{column}</th>)}
          </tr></thead>
          <tbody>{preview.samples.map((row, index) => <tr key={`${row.globalId}:${index}`}>
            <td>{row.model}</td><td>{row.ifcClass}</td><td className="break-words">{row.name}</td>
            {row.values.map((value, column) => <td key={column} className="break-words">{value}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </details>}
  </div>;
}
