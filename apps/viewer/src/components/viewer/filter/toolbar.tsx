/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Filter modal toolbar — AND/OR toggle, limit input, search-bar
 * promotion shortcut, presets dropdown, save action, reset action.
 * UI-only; the parent owns the data flow.
 */

import { Plus, X, Bookmark, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import type { Combinator, FilterRule } from '@/lib/search/filter-rules';
import type { SavedFilterPreset } from '@/lib/search/saved-filters';
import { NumericInput, truncate } from './widgets';
import { RULE_KIND_LABEL } from './rule-editors';

export function CombinatorToggle({
  value,
  onChange,
}: {
  value: Combinator;
  onChange: (next: Combinator) => void;
}) {
  return (
    <div
      className="inline-flex rounded border border-zinc-200 bg-white p-0.5 text-[11px] dark:border-zinc-800 dark:bg-zinc-950"
      title="AND requires every rule to match. OR matches any rule."
    >
      {(['AND', 'OR'] as const).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`rounded px-2 py-0.5 font-mono font-medium transition-colors ${
            value === c
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

export function PresetMenu({
  presets,
  onLoad,
  onDelete,
}: {
  presets: SavedFilterPreset[];
  onLoad: (preset: SavedFilterPreset) => void;
  onDelete: (name: string) => void;
}) {
  if (presets.length === 0) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled
        className="h-7 gap-1 text-[11px] text-muted-foreground"
        title="Save a preset first"
      >
        <Bookmark className="h-3 w-3" /> Presets
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-[11px]"
        >
          <Bookmark className="h-3 w-3" /> Presets
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-[10px] uppercase">Saved presets</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {presets.map((p) => (
          <DropdownMenuItem
            key={p.name}
            onSelect={() => onLoad(p)}
            className="flex items-start justify-between gap-2"
          >
            <div className="flex flex-col">
              <span className="font-medium">{p.name}</span>
              <span className="text-[10px] text-muted-foreground">
                {p.rules.length} rule{p.rules.length === 1 ? '' : 's'} · {p.combinator}
              </span>
            </div>
            <button
              type="button"
              aria-label={`Delete preset ${p.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(p.name);
              }}
              className="rounded p-1 text-muted-foreground hover:bg-zinc-100 hover:text-destructive dark:hover:bg-zinc-800"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AddRuleMenu({
  onAdd,
}: {
  onAdd: (kind: FilterRule['kind']) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 self-start text-xs">
          <Plus className="h-3 w-3" />
          Add rule
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-[10px] uppercase">Filter dimension</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(Object.keys(RULE_KIND_LABEL) as FilterRule['kind'][]).map((k) => (
          <DropdownMenuItem key={k} onSelect={() => onAdd(k)}>
            {RULE_KIND_LABEL[k]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface BuilderToolbarProps {
  combinator: Combinator;
  onCombinatorChange: (next: Combinator) => void;
  limit: number;
  onLimitChange: (next: number) => void;
  searchQuery: string;
  onPromoteSearchQuery: () => void;
  presets: SavedFilterPreset[];
  onLoadPreset: (preset: SavedFilterPreset) => void;
  onDeletePreset: (name: string) => void;
  onSavePreset: () => void;
  canSave: boolean;
  canReset: boolean;
  onReset: () => void;
}

/**
 * Toolbar row for the chip-builder. All UI; the parent passes
 * callbacks for everything that mutates state.
 */
export function BuilderToolbar({
  combinator,
  onCombinatorChange,
  limit,
  onLimitChange,
  searchQuery,
  onPromoteSearchQuery,
  presets,
  onLoadPreset,
  onDeletePreset,
  onSavePreset,
  canSave,
  canReset,
  onReset,
}: BuilderToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <CombinatorToggle value={combinator} onChange={onCombinatorChange} />

      <div className="ml-1 flex items-center gap-1">
        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Limit
        </label>
        <NumericInput
          value={limit}
          min={0}
          parse={(raw) => {
            if (raw === '') return null;
            const n = Number.parseInt(raw, 10);
            return Number.isFinite(n) && n >= 0 ? n : null;
          }}
          onCommit={onLimitChange}
          className="h-7 w-20 text-xs"
        />
        <span className="text-[10px] text-muted-foreground">0 = none</span>
      </div>

      {searchQuery.trim().length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onPromoteSearchQuery}
          className="h-7 gap-1 text-[11px]"
          title="Add a Name contains rule from the search bar query"
        >
          <Plus className="h-3 w-3" />
          Add &ldquo;{truncate(searchQuery.trim(), 18)}&rdquo; as rule
        </Button>
      )}

      <div className="ml-auto flex items-center gap-1">
        <PresetMenu presets={presets} onLoad={onLoadPreset} onDelete={onDeletePreset} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onSavePreset}
          disabled={!canSave}
          className="h-7 gap-1 text-[11px]"
          title="Save the current rules as a named preset"
        >
          <Save className="h-3 w-3" /> Save
        </Button>
        {canReset && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-7 gap-1 text-[11px] text-muted-foreground"
          >
            <X className="h-3 w-3" /> Reset
          </Button>
        )}
      </div>
    </div>
  );
}
