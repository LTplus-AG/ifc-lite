/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Search, Eye, EyeOff, Download, FileText, FileSpreadsheet, FileType } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { EXPORT_LABELS, type ExportFormat } from '@/lib/lists/export';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { formatLocaleCount } from './formatLocaleCount';

/** Native controls separated at the presentation seam to retain the table's size budget. */
export function ListResultsFilters({ searchQuery, onSearch, visibleOnly, onToggleVisible, count, total }: {
  searchQuery: string; onSearch(value: string): void; visibleOnly: boolean; onToggleVisible(): void; count: number; total: number;
}) {
  const { t, locale } = useTranslation();
  return <div className="flex items-center gap-2 px-3 py-1.5 border-b">
    <Search className="h-3.5 w-3.5 text-muted-foreground" />
    <Input aria-label={t('lists.resultsTable.filterInputLabel')} placeholder={t('lists.resultsTable.filterPlaceholder')}
      value={searchQuery} onChange={event => onSearch(event.target.value)}
      className="h-7 text-xs border-0 shadow-none focus-visible:ring-0 px-0" />
    <span className="text-xs text-muted-foreground whitespace-nowrap">
      {searchQuery || visibleOnly ? t('lists.resultsTable.rowCountOfTotal', { count, countDisplay: formatLocaleCount(count, locale), total: formatLocaleCount(total, locale) })
        : t('lists.resultsTable.rowCount', { count, countDisplay: formatLocaleCount(count, locale) })}
    </span>
    <IconButton label={visibleOnly ? t('lists.resultsTable.showingVisibleOnly') : t('lists.resultsTable.showingAllObjects')}
      size="icon-sm" className={cn('h-6 w-6 shrink-0', visibleOnly && 'text-primary')} aria-pressed={visibleOnly} onClick={onToggleVisible}>
      {visibleOnly ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
    </IconButton>
  </div>;
}
export function ListResultsExports({ onExport }: { onExport(format: ExportFormat): void }) {
  const { t } = useTranslation();
  return <div className="flex items-center gap-2 px-3 py-1.5 border-b"><DropdownMenu>
    <DropdownMenuTrigger asChild>
      <IconButton label={t('lists.resultsTable.exportAriaLabel')} tooltip={t('lists.resultsTable.exportEllipsis')} size="icon-sm" className="h-6 w-6 shrink-0">
        <Download className="h-3.5 w-3.5" />
      </IconButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-44">
      <DropdownMenuItem className="gap-2 text-xs" onClick={() => onExport('csv')}><FileText className="h-3.5 w-3.5" /> {EXPORT_LABELS.csv}</DropdownMenuItem>
      <DropdownMenuItem className="gap-2 text-xs" onClick={() => onExport('xlsx')}><FileSpreadsheet className="h-3.5 w-3.5" /> {EXPORT_LABELS.xlsx}</DropdownMenuItem>
      <DropdownMenuItem className="gap-2 text-xs" onClick={() => onExport('pdf')}><FileType className="h-3.5 w-3.5" /> {EXPORT_LABELS.pdf}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu></div>;
}
