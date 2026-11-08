/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { UseTranslationResult } from '@/i18n';
import type { SavedClashReport } from '../clash/saved-report-schema';
import { displayQualityPercent, qualityBand, type QualityGateRow } from '../clash/quality-gate';
import { literalTemplateText } from './bindings';
import { freshBlockId, freshDocumentId } from './persistence';
import { DOCUMENT_VERSION, type DocumentBlock, type DocumentSpec } from './types';

/** A PNG is already a portable document image: no live library dependency or new block kind. */
export function qualityRingPng(percent: number | null, color: string, display?: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 240; canvas.height = 240;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not draw the quality gate ring');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 240, 240);
  ctx.lineWidth = 18; ctx.strokeStyle = '#e5e7eb';
  ctx.beginPath(); ctx.arc(120, 120, 94, 0, 2 * Math.PI); ctx.stroke();
  if (percent !== null) {
    ctx.strokeStyle = color; ctx.beginPath();
    ctx.arc(120, 120, 94, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * percent / 100); ctx.stroke();
  }
  ctx.fillStyle = '#111827'; ctx.font = 'bold 32px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(percent === null ? '—' : `${display ?? displayQualityPercent(percent)}%`, 120, 120);
  return canvas.toDataURL('image/png');
}

/** Text remains searchable and portable; the image supplies the requested colored ring. */
export function qualityGateDocument(report: SavedClashReport, t: UseTranslationResult['t'], renderRing = qualityRingPng): DocumentSpec {
  if (!report.qualityGates) throw new Error('This report has no captured quality gates');
  const text = (value: string, style: 'title' | 'heading' | 'body' | 'small' = 'body'): DocumentBlock =>
    ({ kind: 'text', id: freshBlockId(), style, text: literalTemplateText(value) });
  const blocks: DocumentBlock[] = [text(report.name, 'title'),
    text(t('clashQuality.captured', { when: report.savedAt }), 'small'), text(t('clashQuality.policy'), 'small')];
  for (const row of report.qualityGates.rows) {
    const band = row.percent === null ? null : qualityBand(row.percent, report.qualityGates.config[row.kind]);
    const label = band?.label ?? t(`clashQuality.${row.status as Exclude<QualityGateRow['status'], 'evaluated'>}`);
    blocks.push(text(row.name, 'heading'),
      { kind: 'image', id: freshBlockId(), dataUrl: renderRing(row.percent, band?.color ?? '#64748b', row.percent === null ? undefined : displayQualityPercent(row.percent, report.qualityGates.config[row.kind])), height: 90, align: 'left', caption: label },
      text([t('clashQuality.metric'), `${row.percent === null ? '—' : displayQualityPercent(row.percent, report.qualityGates.config[row.kind]) + '%'} · ${label}`,
        t('clashQuality.counts', { checked: row.checked ?? '—', affected: row.affected ?? '—' }),
        t('clashQuality.models', { models: row.models.map(id => report.models.find(model => model.id === id)?.name ?? id).join(', ') || '—' }),
        t('clashQuality.tolerance', { tolerance: row.tolerance }),
        t('clashQuality.detectionExclusions', { value: row.excludeVoidsAndHosts ? t('clashQuality.enabled') : t('clashQuality.disabled') }),
        ...(row.clearance !== undefined ? [t('clashQuality.clearance', { clearance: row.clearance })] : []),
      ].join('\n')));
    const policy = report.qualityGates.config[row.kind].map(band => `${band.minimum}%: ${band.label} (${band.color})`).join('; ');
    blocks.push(text(policy, 'small'));
  }
  blocks.push(text(t('clashQuality.revision', { revision: report.run.mutationRevision ?? t('clashQuality.unknown') }), 'small'));
  for (const model of report.models) {
    blocks.push(text([model.name, model.sourceContentHash ?? model.sourceFingerprint ?? t('clashQuality.unknown')].join(' · '), 'small'));
  }
  return { version: DOCUMENT_VERSION, id: freshDocumentId(), name: report.name, page: { size: 'A4', orientation: 'portrait' }, blocks };
}
