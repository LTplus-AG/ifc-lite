/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Copy, GripVertical, X } from 'lucide-react';
import type { LensRule } from '@ifc-lite/lens';
import { emptyFilterGroup } from '@ifc-lite/rules';
import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { FilterGroupEditor, type FilterGroupEditorState } from './FilterGroupEditor';

export interface LensRuleEditorProps {
  rule: LensRule;
  index: number;
  onChange: (patch: Partial<LensRule>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  isDragging?: boolean;
  isDragOver?: boolean;
  dropEdge?: 'top' | 'bottom';
  onDragStart?: (index: number) => void;
  onDragEnter?: (index: number) => void;
  onDragEnd?: () => void;
  onDrop?: (index: number) => void;
  onMove?: (from: number, to: number) => void;
}

export function LensRuleEditor({
  rule, index, onChange, onRemove, onDuplicate, isDragging, isDragOver,
  dropEdge, onDragStart, onDragEnter, onDragEnd, onDrop, onMove,
}: LensRuleEditorProps) {
  const { t } = useTranslation();
  const models = useViewerStore((state) => state.models);
  const modelOptions = useMemo(() => [...models.values()].map((model) => ({
    id: model.id, name: model.name, sourceFingerprint: model.sourceFingerprint,
  })), [models]);
  const [activeGroup, setActiveGroup] = useState(0);
  const groupStateRef = useRef<FilterGroupEditorState>({ groups: rule.groups, activeGroup });
  useLayoutEffect(() => {
    groupStateRef.current.groups = rule.groups;
  }, [rule.groups]);

  const changeGroups = (updater: (prev: FilterGroupEditorState) => FilterGroupEditorState) => {
    const next = updater(groupStateRef.current);
    groupStateRef.current = next;
    setActiveGroup(next.activeGroup);
    onChange({ groups: next.groups, unreadableLegacy: undefined });
  };

  return (
    // The fieldset is a pointer drop target; keyboard reordering stays on its native handle button.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <fieldset
      className={cn(
        'px-2 py-1.5 space-y-2 border-y-2 border-transparent transition-[border-color,opacity]',
        isDragOver && (dropEdge === 'bottom' ? 'border-b-primary' : 'border-t-primary'),
        isDragging && 'opacity-40',
      )}
      onDragOver={onDrop ? (event) => { event.preventDefault(); onDragEnter?.(index); } : undefined}
      onDrop={onDrop ? (event) => { event.preventDefault(); onDrop(index); } : undefined}
    >
      <legend className="sr-only">{rule.name}</legend>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={!onMove}
          draggable={!!onMove}
          onDragStart={onMove ? (event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(index));
            onDragStart?.(index);
          } : undefined}
          onDragEnd={onMove ? () => onDragEnd?.() : undefined}
          onKeyDown={onMove ? (event) => {
            if (event.key === 'ArrowUp') { event.preventDefault(); onMove(index, index - 1); }
            else if (event.key === 'ArrowDown') { event.preventDefault(); onMove(index, index + 1); }
          } : undefined}
          aria-label={onMove ? t('lensPanel.ruleEditor.reorderAriaLabel') : undefined}
          title={onMove ? t('lensPanel.ruleEditor.reorderTooltip') : undefined}
          className={cn('flex-shrink-0 -ml-1 rounded-sm', onMove
            ? 'cursor-grab active:cursor-grabbing text-zinc-400 focus-visible:ring-1 focus-visible:ring-primary'
            : 'invisible')}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <input
          type="color"
          value={rule.color}
          onChange={(event) => onChange({ color: event.target.value })}
          aria-label="Rule color"
          className="w-6 h-6 cursor-pointer border-0 p-0 bg-transparent flex-shrink-0 rounded"
        />
        <input
          type="text"
          value={rule.name}
          onChange={(event) => onChange({ name: event.target.value })}
          aria-label="Rule name"
          className="flex-1 min-w-0 text-xs px-1.5 py-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded-sm"
        />
        <select
          value={rule.action}
          onChange={(event) => onChange({ action: event.target.value as LensRule['action'] })}
          aria-label="Rule action"
          className="text-xs px-1.5 py-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded-sm"
        >
          <option value="colorize">{t('lensPanel.action.colorize')}</option>
          <option value="transparent">{t('lensPanel.action.transparent')}</option>
          <option value="hide">{t('lensPanel.action.hide')}</option>
        </select>
        <button type="button" onClick={onDuplicate} aria-label={t('lensPanel.ruleEditor.duplicateTooltip')} title={t('lensPanel.ruleEditor.duplicateTooltip')}>
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onRemove} aria-label={t('lensPanel.ruleEditor.removeTooltip')} title={t('lensPanel.ruleEditor.removeTooltip')}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {rule.unreadableLegacy ? (
        <div role="alert" className="pl-7 text-xs text-amber-700 dark:text-amber-300">
          <p>Saved condition cannot be read: {rule.unreadableLegacy.reason}</p>
          <button type="button" className="underline" onClick={() => changeGroups(() => ({ groups: [emptyFilterGroup()], activeGroup: 0 }))}>
            Replace condition
          </button>
        </div>
      ) : (
        <div className="pl-7">
          <FilterGroupEditor
            groups={rule.groups}
            activeGroup={activeGroup}
            onChange={changeGroups}
            models={modelOptions}
          />
        </div>
      )}
    </fieldset>
  );
}
