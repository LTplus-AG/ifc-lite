/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ValidationPanel`'s `empty` state (#5138 plan §6): two entry cards — IDS
 * validation (mounts the existing `IDSPanel` body) and Information
 * validation (new rule set / open `.rules.json` / a "Recent rule sets"
 * list). Split out of `ValidationPanel.tsx` to keep the orchestrator under
 * its line budget.
 */

import { useRef } from 'react';
import { ClipboardCheck, FileJson, ListChecks, Plus, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { useTranslation } from '@/i18n';
import type { RecentRuleSet } from '@/lib/validation/recent-rule-sets';

interface EntryCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  testId: string;
}

function EntryCard({ icon, title, description, onClick, testId }: EntryCardProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex flex-col items-start gap-2 rounded-lg border border-border p-4 text-left hover:border-primary/50 hover:bg-muted/40 transition-colors"
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="font-medium text-sm">{title}</span>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </button>
  );
}

interface ValidationPanelEmptyProps {
  onSelectIds: () => void;
  onOpenRuleSetFile: (file: File) => Promise<{ ok: boolean; error?: string }>;
  onNewRuleSet: () => void;
  onLoadRecent: (entry: RecentRuleSet) => void;
  recentRuleSets: readonly RecentRuleSet[];
}

export function ValidationPanelEmpty({
  onSelectIds, onOpenRuleSetFile, onNewRuleSet, onLoadRecent, recentRuleSets,
}: ValidationPanelEmptyProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await onOpenRuleSetFile(file);
  };

  return (
    <div className="flex flex-col gap-4 p-4" {...tourAnchor(TOUR_ANCHORS.validationEntry)}>
      <EntryCard
        testId="validation-entry-ids"
        icon={<ClipboardCheck className="h-4 w-4" />}
        title={t('validationPanel.entry.idsTitle')}
        description={t('validationPanel.entry.idsDescription')}
        onClick={onSelectIds}
      />
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center gap-2 mb-1">
          <ListChecks className="h-4 w-4" />
          <span className="font-medium text-sm">{t('validationPanel.entry.rulesTitle')}</span>
        </div>
        <p className="text-xs text-muted-foreground mb-3">{t('validationPanel.entry.rulesDescription')}</p>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" onClick={onNewRuleSet}>
            <Plus className="h-3.5 w-3.5" />
            {t('validationPanel.entry.newRuleSet')}
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            {t('validationPanel.entry.openRuleSet')}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".rules.json,.json"
            className="hidden"
            onChange={(e) => { void handleFileSelect(e); }}
          />
        </div>
        {recentRuleSets.length > 0 && (
          <div className="mt-3">
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              {t('validationPanel.entry.recent')}
            </h4>
            <ul className="flex flex-col gap-1">
              {recentRuleSets.map((entry) => (
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
    </div>
  );
}
