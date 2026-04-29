/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One row in the Raw STEP editor — a positional STEP argument with an
 * inline pen-icon editor. Mirrors the visual rhythm of the existing
 * AttributeEditorField (PropertiesPanel.tsx) but operates against
 * `bim.store.setPositionalAttribute` instead of the named-attribute path.
 */

import { useCallback, useState } from 'react';
import { PenLine, X, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { formatRawStepValue, isInlineEditable, parseRawStepInput } from './raw-step-format';

interface RawStepRowProps {
  modelId: string;
  entityId: number;
  /** Zero-based positional index. */
  index: number;
  /** Schema attribute name (or `Arg N` fallback). */
  name: string;
  /** Current value as parsed by EntityExtractor — null/number/string/array. */
  currentValue: unknown;
  /** Whether this index has an active overlay override. */
  isMutated: boolean;
  /** Set false to lock the row (e.g. native-metadata model). */
  enableEditing: boolean;
}

export function RawStepRow({
  modelId,
  entityId,
  index,
  name,
  currentValue,
  isMutated,
  enableEditing,
}: RawStepRowProps) {
  const setPositionalAttribute = useViewerStore((s) => s.setPositionalAttribute);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const editable = enableEditing && isInlineEditable(currentValue);
  const display = formatRawStepValue(currentValue);

  const inputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) {
      node.focus();
      node.select();
    }
  }, []);

  const startEdit = useCallback(() => {
    if (!editable) return;
    setDraft(display);
    setError(null);
    setEditing(true);
  }, [editable, display]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setError(null);
  }, []);

  const saveEdit = useCallback(() => {
    const parsed = parseRawStepInput(draft);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setPositionalAttribute(modelId, entityId, index, parsed.value);
    bumpMutationVersion();
    setEditing(false);
    setError(null);
  }, [draft, modelId, entityId, index, setPositionalAttribute, bumpMutationVersion]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    },
    [saveEdit, cancelEdit],
  );

  return (
    <div
      className={`group grid grid-cols-[28px_minmax(80px,140px)_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 text-sm border-b border-zinc-200/60 dark:border-zinc-800/60 ${
        isMutated ? 'bg-purple-50/40 dark:bg-purple-950/15' : ''
      }`}
    >
      {/* Positional index */}
      <span
        className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500 tabular-nums tracking-wide"
        aria-label={`positional index ${index}`}
      >
        [{index}]
      </span>

      {/* Schema attribute name */}
      <span
        className="text-zinc-600 dark:text-zinc-400 truncate font-mono text-xs"
        title={name}
      >
        {name}
      </span>

      {/* Value cell — display or input */}
      {editing ? (
        <div className="flex items-center gap-1 min-w-0">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            onBlur={(e) => {
              // Don't save when the blur is caused by clicking the
              // confirm/cancel buttons — those handle their own action.
              const next = e.relatedTarget as HTMLElement | null;
              if (next?.dataset.rawStepAction) return;
              saveEdit();
            }}
            className={`flex-1 min-w-0 h-7 px-2 text-xs font-mono bg-white dark:bg-zinc-900 border outline-none focus:ring-1 ${
              error
                ? 'border-red-400 dark:border-red-500 focus:ring-red-400'
                : 'border-purple-300 dark:border-purple-700 focus:ring-purple-400'
            }`}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `raw-step-err-${entityId}-${index}` : undefined}
          />
        </div>
      ) : (
        <button
          type="button"
          disabled={!editable}
          onClick={startEdit}
          className={`min-w-0 text-left font-mono text-xs truncate px-1.5 py-0.5 rounded ${
            editable
              ? 'cursor-text hover:bg-zinc-100 dark:hover:bg-zinc-800'
              : 'cursor-default text-zinc-500 dark:text-zinc-500'
          } ${
            display === '$'
              ? 'text-zinc-400 dark:text-zinc-600'
              : 'text-zinc-800 dark:text-zinc-200'
          }`}
          title={editable ? 'Click to edit' : 'This value type is not inline-editable'}
        >
          {display}
        </button>
      )}

      {/* Action cluster */}
      <div className="flex items-center gap-1 shrink-0">
        {isMutated && !editing && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label="overlay override active"
                className="inline-block h-1.5 w-1.5 rounded-full bg-purple-500 dark:bg-purple-400"
              />
            </TooltipTrigger>
            <TooltipContent side="left">Overlay override</TooltipContent>
          </Tooltip>
        )}

        {editing ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              data-raw-step-action="save"
              onMouseDown={(e) => e.preventDefault()}
              onClick={saveEdit}
              className="h-6 w-6 p-0 hover:bg-emerald-100 dark:hover:bg-emerald-950/30"
              title="Save (Enter)"
            >
              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              data-raw-step-action="cancel"
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancelEdit}
              className="h-6 w-6 p-0 hover:bg-red-100 dark:hover:bg-red-950/30"
              title="Cancel (Esc)"
            >
              <X className="h-3.5 w-3.5 text-red-500 dark:text-red-400" />
            </Button>
          </>
        ) : editable ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={startEdit}
            className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            title="Edit"
          >
            <PenLine className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
          </Button>
        ) : (
          <span className="h-6 w-6" aria-hidden />
        )}
      </div>

      {/* Validation error — full-width row beneath the value */}
      {error && (
        <p
          id={`raw-step-err-${entityId}-${index}`}
          className="col-span-4 -mt-1 mb-1 ml-[36px] flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400"
        >
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
