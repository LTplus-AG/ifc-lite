/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The add/edit form for one clash rule, split out of `ClashSettingsDialog`
 * when each side gained an advanced filter (#3902).
 *
 * A rule still describes both sides with a type selector — that is what a
 * saved rule set has always meant, and what every run without a filter still
 * uses. A side may additionally carry a filter (class / attribute / property
 * rows joined by AND or OR); when it does, the filter defines that side and
 * the selector stays only as the rule's shorthand description of itself.
 */

import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useTranslation } from '@/i18n';
import type { ClashSeverity } from '@ifc-lite/clash';
import type { ClashSetFilter } from '@/lib/clash/set-filter';
import { ClashSetFilterEditor } from './ClashSetFilterEditor';

/** The rule being edited. `id: null` is a new custom rule. */
export interface ClashRuleDraft {
  id: string | null;
  name: string;
  selectorA: string;
  selectorB: string;
  severity: ClashSeverity;
  filterA?: ClashSetFilter;
  filterB?: ClashSetFilter;
}

export interface ClashRuleDraftEditorProps {
  draft: ClashRuleDraft;
  severities: readonly ClashSeverity[];
  severityLabel: (severity: ClashSeverity) => string;
  /** Classes in the loaded model matching a selector; null when no model. */
  matchCount: (selector: string) => number | null;
  hasModel: boolean;
  onChange: (next: ClashRuleDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  canSave: boolean;
}

export function ClashRuleDraftEditor({
  draft, severities, severityLabel, matchCount, hasModel, onChange, onCancel, onSave, canSave,
}: ClashRuleDraftEditorProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-[#f7768e]/40 bg-muted/30 p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{draft.id ? t('clashTools.ruleEditor.editTitle') : t('clashTools.ruleEditor.newTitle')}</span>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground" title={t('clashTools.ruleEditor.cancelTooltip')}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <input
        value={draft.name}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
        placeholder={t('clashTools.ruleEditor.namePlaceholder')}
        className="h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-sm"
      />
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <SelectorField
          value={draft.selectorA}
          onChange={(v) => onChange({ ...draft, selectorA: v })}
          count={matchCount(draft.selectorA)}
          hasModel={hasModel}
          placeholder={t('clashTools.ruleEditor.selectorAPlaceholder')}
        />
        <span className="text-xs text-muted-foreground">×</span>
        <SelectorField
          value={draft.selectorB}
          onChange={(v) => onChange({ ...draft, selectorB: v })}
          count={matchCount(draft.selectorB)}
          hasModel={hasModel}
          placeholder={t('clashTools.ruleEditor.selectorBPlaceholder')}
        />
      </div>

      {/* Native scroller: a long filter must not push the severity row and the
          save button out of the dialog. Matches the rule list above. */}
      <div className="max-h-[28vh] space-y-2 overflow-y-auto pr-1">
        <ClashSetFilterEditor
          label="Set A"
          filter={draft.filterA}
          onChange={(filterA) => onChange({ ...draft, filterA })}
        />
        <ClashSetFilterEditor
          label="Set B"
          filter={draft.filterB}
          onChange={(filterB) => onChange({ ...draft, filterB })}
        />
      </div>

      <div className="flex items-center gap-2">
        <Select
          value={draft.severity}
          onValueChange={(v) => onChange({ ...draft, severity: v as ClashSeverity })}
        >
          <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            {severities.map((s) => (
              <SelectItem key={s} value={s}>{severityLabel(s)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" className="ml-auto h-8" disabled={!canSave} onClick={onSave}>
          <Check className="h-3.5 w-3.5 mr-1" /> {draft.id ? t('clashTools.ruleEditor.saveButton') : t('clashTools.ruleEditor.addButton')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground leading-snug">
        {t('clashTools.ruleEditor.selectorsIntro')} <code>IfcWall</code>, <code>{t('clashTools.ruleEditor.selectorExamplePipe')}</code>,{' '}
        <code>{t('clashTools.ruleEditor.selectorExampleWallSlab')}</code>, <code>{t('clashTools.ruleEditor.selectorExampleNotSpace')}</code>,{' '}
        <code>*</code>.{' '}
        {t('clashTools.ruleEditor.selectorsHelp')}
      </p>
    </div>
  );
}

/** Type-selector input with a live "matches N classes" hint. */
function SelectorField({
  value, onChange, count, hasModel, placeholder,
}: { value: string; onChange: (v: string) => void; count: number | null; hasModel: boolean; placeholder: string }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-xs font-mono"
      />
      <div className="mt-0.5 h-3 text-xs text-muted-foreground truncate">
        {!hasModel
          ? t('clashTools.ruleEditor.loadModelHint')
          : count === null
            ? ' '
            : count > 0
              ? t('clashTools.ruleEditor.matchCount', { count })
              : t('clashTools.ruleEditor.noMatches')}
      </div>
    </div>
  );
}
