/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One checklist group in the Manual validation tab (#6401): its ring,
 *  name and progress, then its checks in answering or editing form. */

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import type { ChecklistGroup, ManualAnswerMap } from '@/lib/validation/manual/checklist';
import type { ManualCounts } from '@/lib/validation/manual/checklist-summary';
import { ManualValidationRing } from './ManualValidationRing';
import { ManualValidationAnswerRow, ManualValidationEditRow } from './ManualValidationItem';

interface ManualValidationGroupProps {
  group: ChecklistGroup;
  counts: ManualCounts;
  answers: ManualAnswerMap;
  editing: boolean;
  isFirst: boolean;
  isLast: boolean;
  /** The selected model's fingerprint; null disables the verdict controls. */
  fingerprint: string | null;
}

export function ManualValidationGroup({ group, counts, answers, editing, isFirst, isLast, fingerprint }: ManualValidationGroupProps) {
  const { t } = useTranslation();
  const renameGroup = useViewerStore((s) => s.renameManualGroup);
  const moveGroup = useViewerStore((s) => s.moveManualGroup);
  const removeGroup = useViewerStore((s) => s.removeManualGroup);
  const addItem = useViewerStore((s) => s.addManualItem);
  const updateItem = useViewerStore((s) => s.updateManualItem);
  const moveItem = useViewerStore((s) => s.moveManualItem);
  const removeItem = useViewerStore((s) => s.removeManualItem);
  const setAnswer = useViewerStore((s) => s.setManualAnswer);
  const displayName = group.name.trim() || t('manualValidation.group.defaultName');

  return (
    <section className="rounded-md border border-border" data-testid="manual-group" aria-label={displayName}>
      <header className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <ManualValidationRing counts={counts} name={displayName} size={32} />
        {editing ? (
          <Input
            aria-label={t('manualValidation.group.nameLabel')}
            value={group.name}
            onChange={(e) => renameGroup(group.id, e.target.value)}
            className="h-7 flex-1 px-2 text-xs font-medium"
          />
        ) : (
          <h3 className="flex-1 truncate text-xs font-semibold">{displayName}</h3>
        )}
        <span className="text-2xs text-muted-foreground tabular-nums">
          {t('manualValidation.group.progress', { answered: counts.total - counts.unanswered, total: counts.total })}
        </span>
        {editing && (
          <>
            <IconButton label={t('manualValidation.group.moveUp')} className="h-7 w-7" disabled={isFirst} onClick={() => moveGroup(group.id, -1)}>
              <ArrowUp className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label={t('manualValidation.group.moveDown')} className="h-7 w-7" disabled={isLast} onClick={() => moveGroup(group.id, 1)}>
              <ArrowDown className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label={t('manualValidation.group.remove')} className="h-7 w-7" onClick={() => removeGroup(group.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </>
        )}
      </header>
      <div className="px-2">
        {group.items.length === 0 && !editing && (
          <p className="py-2 text-2xs text-muted-foreground">{t('manualValidation.emptyGroup')}</p>
        )}
        <ul>
          {group.items.map((item, index) => (editing ? (
            <ManualValidationEditRow
              key={item.id}
              item={item}
              isFirst={index === 0}
              isLast={index === group.items.length - 1}
              onChange={(patch) => updateItem(group.id, item.id, patch)}
              onMove={(delta) => moveItem(group.id, item.id, delta)}
              onRemove={() => removeItem(group.id, item.id)}
            />
          ) : (
            <ManualValidationAnswerRow
              key={item.id}
              item={item}
              answer={answers[item.id]}
              canAnswer={fingerprint !== null}
              onVerdict={(status) => { if (fingerprint) setAnswer(fingerprint, item.id, { status }); }}
              onComment={(comment) => { if (fingerprint) setAnswer(fingerprint, item.id, { comment }); }}
            />
          )))}
        </ul>
        {editing && (
          <Button type="button" variant="ghost" size="sm" className="my-1 h-7 gap-1 text-xs" onClick={() => addItem(group.id, '')}>
            <Plus className="h-3.5 w-3.5" />
            {t('manualValidation.item.add')}
          </Button>
        )}
      </div>
    </section>
  );
}
