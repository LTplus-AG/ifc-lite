/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inline editor for one IFC attribute (Name, Description, GlobalId, …) in the
 * Properties panel: click or the pen icon to edit, Enter / blur / check to
 * commit, Escape to cancel.
 *
 * A commit is recorded only when it changes something and passes validation
 * (#5872). Before, every blur recorded an undo entry, cleared redo and marked
 * the model dirty even for an untouched value; Enter committed and the
 * unmount's blur could commit again; and GlobalId took any string.
 */

import { useCallback, useRef, useState } from 'react';
import { Check, PenLine } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';
import { globalIdProblem, modelGlobalIdOwner } from './global-id-check';

export type AttributeEditVerdict =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; messageKey: TranslationKey }
  | { kind: 'commit'; value: string };

/**
 * Decide what committing `input` for `attrName` should do. `globalIdOwner`
 * returns the expressId already carrying a GlobalId in this model, or a
 * non-positive number when none does.
 */
export function judgeAttributeEdit(
  attrName: string,
  input: string,
  currentValue: string,
  entityId: number,
  globalIdOwner: (guid: string) => number,
): AttributeEditVerdict {
  const trimmed = input.trim();
  // Whitespace alone is not a new IFC value. Keep intentional whitespace on
  // changed free text, but do not create an undo step for a trim-equal edit.
  if (trimmed === currentValue.trim()) return { kind: 'unchanged' };
  const value = attrName === 'GlobalId' ? trimmed : trimmed === '' ? '$' : input;
  if (attrName === 'GlobalId') {
    const problem = globalIdProblem(value, entityId, globalIdOwner);
    if (problem) return { kind: 'invalid', messageKey: problem };
  }
  return { kind: 'commit', value };
}

export function AttributeEditorField({ modelId, entityId, attrName, currentValue }: { modelId: string; entityId: number; attrName: string; currentValue: string }) {
  const { t } = useTranslation();
  const setAttribute = useViewerStore((s) => s.setAttribute);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentValue);
  const [error, setError] = useState<TranslationKey | null>(null);
  // Set once a commit or cancel has decided this edit, so the blur that
  // follows Enter / Escape (the input unmounts) cannot commit a second time.
  const settledRef = useRef(false);
  const inputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) { node.focus(); node.select(); }
  }, []);

  const begin = useCallback(() => {
    settledRef.current = false;
    setValue(currentValue);
    setError(null);
    setEditing(true);
  }, [currentValue]);

  const save = useCallback(() => {
    if (settledRef.current) return;
    const storeModelId = modelId === 'legacy' ? '__legacy__' : modelId;
    const verdict = judgeAttributeEdit(attrName, value, currentValue, entityId, modelGlobalIdOwner(modelId));
    if (verdict.kind === 'invalid') {
      setError(verdict.messageKey);
      return;
    }
    settledRef.current = true;
    // setAttribute records the undo entry, marks the model dirty and bumps
    // mutationVersion itself; an unchanged value records nothing.
    // `$` is the existing named-attribute null marker. An explicit empty
    // string would export as STEP `''`, which is present rather than absent.
    // Undo restores a prior session edit exactly (even ''); with none, it
    // drops the overlay and restores the source token.
    const prior = useViewerStore.getState().mutationViews.get(storeModelId)?.getAttributeMutationsForEntity(entityId).find((m) => m.name === attrName);
    if (verdict.kind === 'commit') setAttribute(storeModelId, entityId, attrName, verdict.value, prior ? prior.value : currentValue || undefined);
    setEditing(false);
  }, [modelId, entityId, attrName, value, currentValue, setAttribute]);

  const cancel = useCallback(() => {
    settledRef.current = true;
    setValue(currentValue);
    setError(null);
    setEditing(false);
  }, [currentValue]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }, [save, cancel]);

  if (editing) {
    return (
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-1 min-w-0">
          <input
            ref={inputRef}
            value={value}
            aria-label={attrName}
            aria-invalid={error !== null}
            aria-describedby={error ? `attr-err-${entityId}-${attrName}` : undefined}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            onKeyDown={handleKeyDown}
            onBlur={save}
            className="flex-1 min-w-0 h-6 px-1.5 text-sm font-mono bg-white dark:bg-zinc-900 border border-overlay-accent/40 outline-none focus:ring-1 focus:ring-overlay-accent aria-[invalid=true]:border-red-500"
          />
          <IconButton
            label={t('properties.panel.saveAttributeLabel', { attrName })}
            className="h-5 w-5 p-0 shrink-0 hover:bg-emerald-100 dark:hover:bg-emerald-900/30"
            onClick={save}
          >
            <Check className="h-3 w-3 text-emerald-500" />
          </IconButton>
        </div>
        {error && <span id={`attr-err-${entityId}-${attrName}`} role="alert" className="text-xs text-red-600 dark:text-red-400">{t(error)}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center gap-1 min-w-0 group/attr">
      <button
        type="button"
        className="font-medium whitespace-nowrap truncate flex-1 min-w-0 cursor-text border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        title={currentValue}
        onClick={begin}
      >
        {currentValue || <span className="text-zinc-400 italic">{t('properties.panel.attributeEditor.emptyValue')}</span>}
      </button>
      <IconButton
        label={t('properties.panel.attributeEditor.editTooltip')}
        tooltipSide="left"
        className="h-5 w-5 p-0 shrink-0 opacity-0 group-hover/attr:opacity-100 hover:bg-overlay-accent-soft transition-opacity"
        onClick={begin}
      >
        <PenLine className="h-3 w-3 text-overlay-accent" />
      </IconButton>
    </div>
  );
}
