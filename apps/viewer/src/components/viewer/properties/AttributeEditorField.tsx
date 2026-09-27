/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useState } from 'react';
import { Check, PenLine } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';

/** Inline attribute editor — pen icon to enter edit mode, input + save/cancel */
export function AttributeEditorField({ modelId, entityId, attrName, currentValue }: { modelId: string; entityId: number; attrName: string; currentValue: string }) {
  const { t } = useTranslation();
  const setAttribute = useViewerStore((s) => s.setAttribute);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentValue);
  const inputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) { node.focus(); node.select(); }
  }, []);

  const save = useCallback(() => {
    let normalizedModelId = modelId;
    if (modelId === 'legacy') normalizedModelId = '__legacy__';
    setAttribute(normalizedModelId, entityId, attrName, value, currentValue || undefined);
    bumpMutationVersion();
    setEditing(false);
  }, [modelId, entityId, attrName, value, currentValue, setAttribute, bumpMutationVersion]);

  const cancel = useCallback(() => {
    setValue(currentValue);
    setEditing(false);
  }, [currentValue]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }, [save, cancel]);

  if (editing) {
    return (
      <div className="flex flex-1 items-center gap-1 min-w-0">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={save}
          className="flex-1 min-w-0 h-6 px-1.5 text-sm font-mono bg-white dark:bg-zinc-900 border border-overlay-accent/40 outline-none focus:ring-1 focus:ring-overlay-accent"
        />
        <IconButton
          label={t('properties.panel.saveAttributeLabel', { attrName })}
          className="h-5 w-5 p-0 shrink-0 hover:bg-emerald-100 dark:hover:bg-emerald-900/30"
          onClick={save}
        >
          <Check className="h-3 w-3 text-emerald-500" />
        </IconButton>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center gap-1 min-w-0 group/attr">
      <button type="button"
        className="font-medium whitespace-nowrap truncate flex-1 min-w-0 cursor-text border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        title={currentValue}
        onClick={() => setEditing(true)}
      >
        {currentValue || <span className="text-zinc-400 italic">{t('properties.panel.attributeEditor.emptyValue')}</span>}
      </button>
      <IconButton
        label={t('properties.panel.attributeEditor.editTooltip')}
        tooltipSide="left"
        className="h-5 w-5 p-0 shrink-0 opacity-0 group-hover/attr:opacity-100 hover:bg-overlay-accent-soft transition-opacity"
        onClick={() => setEditing(true)}
      >
        <PenLine className="h-3 w-3 text-overlay-accent" />
      </IconButton>
    </div>
  );
}
