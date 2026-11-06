/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ValidationPanel`'s `empty` state (#5138 plan §6): three entry cards — IDS
 * validation (its "Load IDS file" mounts the existing `IDSPanel` body and
 * opens that side's file picker) and Information
 * validation (new rule set / open `.rules.json` / import an IDS as rules /
 * a "Recent rule sets" list), and Manual validation checklists (#6401). Split out of `ValidationPanel.tsx` to keep the orchestrator under
 * its line budget.
 *
 * `InformationValidationEntry` (the rules card's body) is exported
 * separately: once a source is chosen the persistent header toggle can
 * switch to "Information validation" with no rule set loaded yet, and that
 * state reuses this exact content rather than a second copy of it.
 */

import { useRef } from 'react';
import { ClipboardCheck, FileJson, ListChecks, Plus, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { useTranslation } from '@/i18n';
import type { RecentRuleSet } from '@/lib/validation/recent-rule-sets';
import { ManualValidationEntry, type ManualValidationEntryProps } from './ManualValidationEntry';
import { EntryHeading, ENTRY_ACTIONS, ENTRY_BUTTON } from './ValidationEntryHeading';

export interface InformationValidationEntryProps {
  onOpenRuleSetFile: (file: File) => Promise<{ ok: boolean; error?: string }>;
  /** Convert an IDS file's simple specifications into a new rule set (#5225). */
  onImportIds: (file: File) => Promise<{ ok: boolean; error?: string }>;
  onNewRuleSet: () => void;
  onLoadRecent: (entry: RecentRuleSet) => void;
  recentRuleSets: readonly RecentRuleSet[];
  /** Shown when a "Recent" entry or a picked file failed to load. */
  error?: string | null;
}

/** New / Open / Recent — the whole "Information validation" entry body,
 *  reused both as a card (empty state) and standalone (the header toggle's
 *  "Information validation" side with no rule set loaded yet). */
export function InformationValidationEntry({
  onOpenRuleSetFile, onImportIds, onNewRuleSet, onLoadRecent, recentRuleSets, error = null,
}: InformationValidationEntryProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const idsInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await onOpenRuleSetFile(file);
  };

  const handleIdsSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await onImportIds(file);
  };

  return (
    <div>
      <EntryHeading icon={<ListChecks />} title={t('validationPanel.entry.rulesTitle')} description={t('validationPanel.entry.rulesDescription')} />
      <div className={ENTRY_ACTIONS}>
        <Button type="button" size="sm" variant="outline" className={ENTRY_BUTTON} onClick={onNewRuleSet}>
          <Plus className="h-3.5 w-3.5" />
          {t('validationPanel.entry.newRuleSet')}
        </Button>
        <Button type="button" size="sm" variant="ghost" className={ENTRY_BUTTON} onClick={() => fileInputRef.current?.click()}>
          {t('validationPanel.entry.openRuleSet')}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".rules.json,.json"
          className="hidden"
          onChange={(e) => { void handleFileSelect(e); }}
        />
        <Button type="button" size="sm" variant="ghost" className={ENTRY_BUTTON} onClick={() => idsInputRef.current?.click()}>
          {t('validationPanel.entry.importIds')}
        </Button>
        <input
          ref={idsInputRef}
          type="file"
          accept=".ids,.xml"
          className="hidden"
          data-testid="validation-import-ids-input"
          onChange={(e) => { void handleIdsSelect(e); }}
        />
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {recentRuleSets.length > 0 && (
        <div className="mt-3">
          <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
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
  );
}

interface ValidationPanelEmptyProps {
  /** Switch to the IDS side and open its file picker (cancelling it leaves the IDS side, its library and demo, on screen). */
  onLoadIds: () => void;
  onOpenRuleSetFile: (file: File) => Promise<{ ok: boolean; error?: string }>;
  onImportIds: (file: File) => Promise<{ ok: boolean; error?: string }>;
  onNewRuleSet: () => void;
  onLoadRecent: (entry: RecentRuleSet) => void;
  recentRuleSets: readonly RecentRuleSet[];
  error?: string | null;
  /** The third card: Manual validation checklists (#6401). */
  manual: ManualValidationEntryProps;
}

export function ValidationPanelEmpty({
  onLoadIds, onOpenRuleSetFile, onImportIds, onNewRuleSet, onLoadRecent, recentRuleSets, error, manual,
}: ValidationPanelEmptyProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3 p-3" {...tourAnchor(TOUR_ANCHORS.validationEntry)}>
      <section className={ENTRY_CARD} aria-label={t('validationPanel.entry.idsTitle')}>
        <EntryHeading icon={<ClipboardCheck />} title={t('validationPanel.entry.idsTitle')} description={t('validationPanel.entry.idsDescription')} />
        <div className={ENTRY_ACTIONS}>
          <Button type="button" size="sm" className={ENTRY_BUTTON} data-testid="validation-entry-ids" onClick={onLoadIds}>
            <Upload className="h-3.5 w-3.5" />
            {t('idsPanel.loadFile')}
          </Button>
        </div>
      </section>
      <section className={ENTRY_CARD} aria-label={t('validationPanel.entry.rulesTitle')}>
        <InformationValidationEntry
          onOpenRuleSetFile={onOpenRuleSetFile}
          onImportIds={onImportIds}
          onNewRuleSet={onNewRuleSet}
          onLoadRecent={onLoadRecent}
          recentRuleSets={recentRuleSets}
          error={error}
        />
      </section>
      <section className={ENTRY_CARD} aria-label={t('manualValidation.entry.title')} data-testid="validation-entry-manual">
        <ManualValidationEntry {...manual} />
      </section>
    </div>
  );
}

const ENTRY_CARD = 'rounded-md border border-border p-3';
