/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTranslation } from '@/i18n';
import type { SavedClashReport } from '@/lib/clash/saved-report-schema';
import type { QualityGateBlock } from '@/lib/document/types';

interface Props {
  block: QualityGateBlock;
  reports: readonly SavedClashReport[];
  onChange: (block: QualityGateBlock) => void;
}

export function QualityGateBlockEditor({ block, reports, onChange }: Props) {
  const { t } = useTranslation();
  const available = reports.filter(report => report.qualityGates?.rows.length);
  const source = available.find(report => report.id === block.clashReportId);
  const rows = source?.qualityGates?.rows ?? [];
  const selected = block.row === undefined ? undefined : rows[block.row];
  const rowPlaceholder = block.row === undefined ? t('document.qualityGate.chooseResult') : t('document.qualityGate.missing');
  const missing = t('document.qualityGate.missing');
  return <div className="flex flex-col gap-1">
    <Field label={t('document.qualityGate.report')}>
      <Select value={source?.id ?? ''} disabled={!available.length} onValueChange={id => {
        const report = available.find(candidate => candidate.id === id);
        if (!report?.qualityGates?.rows.length) return;
        const matchingRow = report.qualityGates.rows.findIndex(row => row.rule === selected?.rule && row.kind === selected.kind);
        onChange({ ...block, clashReportId: report.id, row: matchingRow < 0 ? undefined : matchingRow });
      }}>
        <SelectTrigger><SelectValue placeholder={missing} /></SelectTrigger>
        <SelectContent>{available.map(report => <SelectItem key={report.id} value={report.id}>
          {report.name} · {new Date(report.savedAt).toLocaleString()}
        </SelectItem>)}</SelectContent>
      </Select>
    </Field>
    {source && <Field label={t('document.qualityGate.rule')}>
      <Select value={selected ? String(block.row) : ''} onValueChange={value => {
        const row = Number(value);
        if (value && rows[row]) onChange({ ...block, row });
      }}>
        <SelectTrigger><SelectValue placeholder={rowPlaceholder} /></SelectTrigger>
        <SelectContent>{rows.map((row, index) => <SelectItem key={index} value={String(index)}>
          {row.name} · {t(row.kind === 'clash' ? 'clashQuality.clash' : 'clashQuality.duplicates')}
        </SelectItem>)}</SelectContent>
      </Select>
    </Field>}
  </div>;
}
