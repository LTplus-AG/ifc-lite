/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One check row in the Manual validation tab (#6401). Two faces:
 *
 * - answering: what was checked on the left, the Pass / Fail / Warning
 *   toggle buttons, and a comment field. Pressing the active verdict again
 *   clears it back to "Not checked", which shows as its own state.
 * - editing: the check's text and guidance as inputs, with reorder and
 *   delete buttons.
 *
 * Every control is a native button or field, so Tab / Enter / Space work
 * without custom key handling, and every icon-only button has a label.
 */

import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { MANUAL_VERDICTS, type ChecklistItem, type ManualAnswer, type ManualVerdict } from '@/lib/validation/manual/checklist';
import { RING_COLORS } from '@/lib/validation/manual/ring';
import { VerdictIcon } from './ManualValidationRing';

const VERDICT_LABEL: Record<ManualVerdict, TranslationKey> = {
  pass: 'manualValidation.verdict.pass',
  fail: 'manualValidation.verdict.fail',
  warning: 'manualValidation.verdict.warning',
};

interface AnswerRowProps {
  item: ChecklistItem;
  answer: ManualAnswer | undefined;
  /** False when no model with a stable identity is selected. */
  canAnswer: boolean;
  onVerdict: (status: ManualVerdict | null) => void;
  onComment: (comment: string) => void;
}

export function ManualValidationAnswerRow({ item, answer, canAnswer, onVerdict, onComment }: AnswerRowProps) {
  const { t } = useTranslation();
  const status = answer?.status ?? null;
  const checkName = item.text.trim() || t('manualValidation.item.untitled');

  return (
    <li className="flex flex-col gap-1.5 border-b border-border/60 py-2 last:border-b-0" data-testid="manual-check" data-status={status ?? 'unanswered'}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-[10rem] flex-1">
          <div className="text-xs font-medium break-words">{checkName}</div>
          {item.description && <div className="text-2xs text-muted-foreground break-words">{item.description}</div>}
        </div>
        <fieldset className="m-0 flex items-center gap-1 border-0 p-0">
          <legend className="sr-only">{t('manualValidation.item.verdictGroup', { check: checkName })}</legend>
          {MANUAL_VERDICTS.map((verdict) => {
            const active = status === verdict;
            return (
              <button
                key={verdict}
                type="button"
                aria-pressed={active}
                disabled={!canAnswer}
                onClick={() => onVerdict(active ? null : verdict)}
                className={cn(
                  'inline-flex h-7 items-center gap-1 rounded border px-2 text-2xs transition-colors',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                  active ? 'font-semibold text-foreground' : 'border-border text-muted-foreground hover:bg-muted/60',
                )}
                style={active ? { borderColor: RING_COLORS[verdict], backgroundColor: `${RING_COLORS[verdict]}1f` } : undefined}
              >
                <VerdictIcon bucket={verdict} className="h-3 w-3" />
                {t(VERDICT_LABEL[verdict])}
              </button>
            );
          })}
        </fieldset>
      </div>
      {status === null && (
        <div className="flex items-center gap-1 text-2xs text-muted-foreground">
          <VerdictIcon bucket="unanswered" className="h-3 w-3" />
          {t('manualValidation.verdict.unanswered')}
        </div>
      )}
      <Textarea
        aria-label={t('manualValidation.item.commentLabel', { check: checkName })}
        placeholder={t('manualValidation.item.commentPlaceholder')}
        value={answer?.comment ?? ''}
        disabled={!canAnswer}
        onChange={(e) => onComment(e.target.value)}
        rows={1}
        className="min-h-[28px] px-2 py-1 text-xs"
      />
    </li>
  );
}

interface EditRowProps {
  item: ChecklistItem;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: { text?: string; description?: string }) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}

export function ManualValidationEditRow({ item, isFirst, isLast, onChange, onMove, onRemove }: EditRowProps) {
  const { t } = useTranslation();
  return (
    <li className="flex items-start gap-1 border-b border-border/60 py-1.5 last:border-b-0" data-testid="manual-check-edit">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Input
          aria-label={t('manualValidation.item.textLabel')}
          placeholder={t('manualValidation.item.textPlaceholder')}
          value={item.text}
          onChange={(e) => onChange({ text: e.target.value })}
          className="h-7 px-2 text-xs"
        />
        <Input
          aria-label={t('manualValidation.item.descriptionLabel')}
          placeholder={t('manualValidation.item.descriptionLabel')}
          value={item.description ?? ''}
          onChange={(e) => onChange({ description: e.target.value })}
          className="h-6 px-2 text-2xs"
        />
      </div>
      <IconButton label={t('manualValidation.item.moveUp')} className="h-7 w-7" disabled={isFirst} onClick={() => onMove(-1)}>
        <ArrowUp className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton label={t('manualValidation.item.moveDown')} className="h-7 w-7" disabled={isLast} onClick={() => onMove(1)}>
        <ArrowDown className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton label={t('manualValidation.item.remove')} className="h-7 w-7" onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
      </IconButton>
    </li>
  );
}
