/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { resolveEnglish } from '@/i18n/registry';
import { displayQualityPercent, qualityBand, type QualityGateRow, type QualityBand } from '../clash/quality-gate';
import type { SavedClashReport } from '../clash/saved-report-schema';
import { blockTitle, blockHeaderStyleFields, type BlockHeaderStyleFields } from './block-title';
import type { DocumentLabelFormatter } from './document-labels';
import type { QualityGateBlock } from './types';

export interface QualityGateRing {
  percent: number | null;
  color: string;
  display: string;
}

export function describeQualityGate(report: SavedClashReport, row: QualityGateRow, ranges: readonly QualityBand[], t: DocumentLabelFormatter) {
  const band = row.percent !== null ? qualityBand(row.percent, ranges) : null;
  const label = band?.label ?? t(row.status === 'evaluated' ? 'clashQuality.unavailable' : `clashQuality.${row.status}`);
  const display = row.percent === null ? '—' : `${displayQualityPercent(row.percent, ranges)}%`;
  const ring: QualityGateRing = { percent: row.percent, color: band?.color ?? '#64748b', display };
  const details = [t('clashQuality.metric'), `${display} · ${label}`,
    t('clashQuality.counts', { checked: row.checked ?? '—', affected: row.affected ?? '—' }),
    t('clashQuality.models', { models: row.models.map(id => report.models.find(model => model.id === id)?.name ?? id).join(', ') || '—' }),
    t('clashQuality.tolerance', { tolerance: row.tolerance }),
    t('clashQuality.detectionExclusions', { value: row.excludeVoidsAndHosts ? t('clashQuality.enabled') : t('clashQuality.disabled') }),
    ...(row.clearance === undefined ? [] : [t('clashQuality.clearance', { clearance: row.clearance })]),
  ];
  const policy = ranges.map(range => `${range.minimum}%: ${range.label} (${range.color})`).join('; ');
  return { ring, label, details, policy };
}

export interface ResolvedQualityGate extends BlockHeaderStyleFields {
  kind: 'quality-gate';
  id: string;
  title: string;
  scale?: number;
  lines: string[];
  ring?: QualityGateRing;
}

export function resolveQualityGate(block: QualityGateBlock, reports: readonly SavedClashReport[],
  t: DocumentLabelFormatter = resolveEnglish): ResolvedQualityGate {
  const report = reports.find(candidate => candidate.id === block.clashReportId);
  const quality = report?.qualityGates;
  const row = block.row === undefined ? undefined : quality?.rows[block.row];
  const base = { kind: block.kind, id: block.id, scale: block.scale, ...blockHeaderStyleFields(block) };
  if (!report || !quality || !row) {
    const lines = report && quality && block.row === undefined
      ? [report.name, t('document.qualityGate.chooseResult')]
      : [t('document.qualityGate.missing')];
    return { ...base, title: blockTitle(block, t('document.block.kindQualityGate')), lines };
  }
  const { ring, details, policy } = describeQualityGate(report, row, quality.config[row.kind], t);
  return { ...base, title: blockTitle(block, row.name), ring,
    lines: [report.name, t('clashQuality.captured', { when: report.savedAt }), ...details,
      t('clashQuality.policy'), policy, t('clashQuality.revision', { revision: report.run.mutationRevision ?? t('clashQuality.unknown') })] };
}

/** One vector ring for the paper preview and PDF exporter. */
export function qualityGateRingSvg({ percent, color, display }: QualityGateRing): string {
  const radius = 39, size = 100, center = size / 2;
  const circle = `cx="${center}" cy="${center}" r="${radius}" fill="none" stroke-width="8"`;
  const track = `<circle ${circle} stroke="#e5e7eb"/>`;
  const safeColor = /^#[\da-f]{6}$/i.test(color) ? color : '#64748b';
  let arc = '';
  if (percent !== null && percent >= 100) arc = `<circle ${circle} stroke="${safeColor}"/>`;
  else if (percent !== null && percent > 0) {
    const radians = 2 * Math.PI * percent / 100;
    const x = center + radius * Math.sin(radians), y = center - radius * Math.cos(radians);
    arc = `<path d="M ${center} ${center - radius} A ${radius} ${radius} 0 ${percent > 50 ? 1 : 0} 1 ${x} ${y}" fill="none" stroke="${safeColor}" stroke-width="8"/>`;
  }
  const text = /^[\d.e+%—-]+$/i.test(display) ? display : '—';
  const fontSize = Math.min(16, Math.floor(84 / text.length));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${track}${arc}`
    + `<text x="50" y="55" text-anchor="middle" font-family="Helvetica" font-size="${fontSize}" fill="#111827">${text}</text></svg>`;
}
