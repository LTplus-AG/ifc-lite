/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { Plus, Save } from 'lucide-react';
import { emptyFilterGroup } from '@ifc-lite/rules';
import type { Lens, LensRule } from '@/store/slices/lensSlice';
import { LENS_PALETTE } from '@/store/slices/lensSlice';
import { cloneLensRules, isRuleValid, moveItem } from './lens-editor-utils';
import { LensRuleEditor } from './LensRuleEditor';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { CapturedScopeControl } from './result/CapturedScopeControl';

export function LensEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: Lens;
  onSave: (lens: Lens) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [capturedScope, setCapturedScope] = useState(initial.capturedScope);
  // Editing a built-in or duplicate must not mutate the source's groups.
  const [rules, setRules] = useState<LensRule[]>(() => cloneLensRules(initial.rules));
  // Drag-to-reorder state. Rule order is meaningful: the engine applies the
  // first matching rule per entity, so order = priority. (#1403)
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const moveRule = (from: number, to: number) => {
    setRules((prev) => moveItem(prev, from, to));
  };

  const handleDrop = (to: number) => {
    setRules((prev) => (dragIndex === null ? prev : moveItem(prev, dragIndex, to)));
    setDragIndex(null);
    setDragOverIndex(null);
  };

  // Unique rule id: a random suffix (not the array length) so add / duplicate /
  // remove interleaving within one millisecond can never collide React keys. (#1460)
  const newRuleId = () => `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const addRule = () => {
    const colorIndex = rules.length % LENS_PALETTE.length;
    setRules([...rules, {
      id: newRuleId(),
      name: 'New Rule',
      enabled: true,
      groups: [emptyFilterGroup()],
      action: 'colorize',
      color: LENS_PALETTE[colorIndex],
    }]);
  };

  const updateRule = (index: number, patch: Partial<LensRule>) => {
    setRules((prev) => prev.map((r, i) => i === index ? { ...r, ...patch } : r));
  };

  const removeRule = (index: number) => {
    setRules(rules.filter((_, i) => i !== index));
  };

  // Clone the filter groups rather than sharing mutable chip arrays. (#1460)
  const duplicateRule = (index: number) => {
    setRules((prev) => {
      const src = prev[index];
      if (!src) return prev;
      const copy: LensRule = {
        ...src,
        id: newRuleId(),
        groups: structuredClone(src.groups ?? []),
        unreadableLegacy: src.unreadableLegacy ? structuredClone(src.unreadableLegacy) : undefined,
      };
      const next = [...prev];
      next.splice(index + 1, 0, copy);
      return next;
    });
  };

  const handleSave = () => {
    if (!name.trim() || rules.length === 0 || !rules.every(isRuleValid)) return;
    onSave({ ...initial, name: name.trim(), rules, capturedScope });
  };

  const canSave = name.trim().length > 0 && rules.length > 0 && rules.every(isRuleValid);

  return (
    <div className="border-2 border-primary bg-white dark:bg-zinc-900 rounded-sm">
      {/* Name input */}
      <div className="px-3 pt-3 pb-2">
        <input
          type="text" value={name} aria-label={t('lensPanel.editor.namePlaceholder')}
          onChange={(e) => setName(e.target.value)} placeholder={t('lensPanel.editor.namePlaceholder')}
          className="w-full px-2 py-1.5 text-xs font-bold uppercase tracking-wider bg-zinc-50 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm placeholder:normal-case placeholder:font-normal placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
          // This input appears only when the user opens the editor; focus starts at its name field.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
      </div>

      <CapturedScopeControl scope={capturedScope} onChange={setCapturedScope} />

      {/* Rules */}
      <div className="border-t border-zinc-200 dark:border-zinc-700 py-1 bg-zinc-50/50 dark:bg-zinc-800/50">
        {rules.map((rule, i) => (
          <LensRuleEditor
            key={rule.id}
            rule={rule}
            index={i}
            onChange={(patch) => updateRule(i, patch)}
            onRemove={() => removeRule(i)}
            onDuplicate={() => duplicateRule(i)}
            isDragging={dragIndex === i}
            isDragOver={dragOverIndex === i && dragIndex !== null && dragIndex !== i}
            // Indicator edge matches where moveItem lands the rule: a downward
            // drag (source above target) lands below the hovered row. (#1403)
            dropEdge={dragIndex !== null && dragIndex < i ? 'bottom' : 'top'}
            onDragStart={rules.length > 1 ? setDragIndex : undefined}
            onDragEnter={setDragOverIndex}
            onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
            onDrop={dragIndex !== null ? handleDrop : undefined /* a file drag is not a reorder (#5845) */}
            onMove={rules.length > 1 ? moveRule : undefined}
          />
        ))}

        <button
          onClick={addRule}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary hover:text-primary/80 w-full"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('lensPanel.editor.addRule')}
        </button>
      </div>

      {/* Actions */}
      <div className="flex gap-1.5 p-2 border-t border-zinc-200 dark:border-zinc-700">
        <Button
          variant="default"
          size="sm"
          className="flex-1 h-7 text-2xs uppercase tracking-wider rounded-sm"
          onClick={handleSave}
          disabled={!canSave}
        >
          <Save className="h-3 w-3 mr-1" />
          {t('lensPanel.editor.save')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-2xs uppercase tracking-wider rounded-sm"
          onClick={onCancel}
        >
          {t('lensPanel.editor.cancel')}
        </Button>
      </div>
    </div>
  );
}
