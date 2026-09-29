/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** New / Open / Recent for manual-validation checklists (#6401) — the
 *  Manual validation tab's body before a checklist is loaded, and the third
 *  card on the Data validation panel's empty state. */

import { useRef } from 'react';
import { ClipboardList, FileJson, Plus, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import type { RecentChecklist } from '@/lib/validation/manual/recent-checklists';

export interface ManualValidationEntryProps {
  onNew: () => void;
  onOpenFile: (file: File) => Promise<void>;
  onLoadRecent: (entry: RecentChecklist) => void;
  recent: readonly RecentChecklist[];
  error?: string | null;
}

export function ManualValidationEntry({ onNew, onOpenFile, onLoadRecent, recent, error = null }: ManualValidationEntryProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await onOpenFile(file);
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <ClipboardList className="h-4 w-4" />
        <span className="font-medium text-sm">{t('manualValidation.entry.title')}</span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">{t('manualValidation.entry.description')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" onClick={onNew}>
          <Plus className="h-3.5 w-3.5" />
          {t('manualValidation.entry.new')}
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => fileInputRef.current?.click()}>
          <Upload className="h-3.5 w-3.5" />
          {t('manualValidation.entry.open')}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".checklist.json,.json"
          className="hidden"
          data-testid="manual-checklist-input"
          onChange={(e) => { void handleFileSelect(e); }}
        />
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
      {recent.length > 0 && (
        <div className="mt-3">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            {t('manualValidation.entry.recent')}
          </h4>
          <ul className="flex flex-col gap-1">
            {recent.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/60 truncate"
                  onClick={() => onLoadRecent(entry)}
                >
                  <FileJson className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
