/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SearchModal.sql.builder — chip-based visual query builder.
 *
 * Compiles to real DuckDB SQL via `generateSqlFromBuilder`. Pair with
 * the Editor mode to get a "see what your chips compile to" teaching
 * path (the Run button works in both modes, so users never leave the
 * SQL tab to test their query).
 */

import { useMemo, useCallback } from 'react';
import { Plus, Trash2, ArrowRight } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  generateSqlFromBuilder,
  COMMON_IFC_TYPES,
  type BuilderOp,
  type BuilderValueType,
  type PropertyFilter,
} from '@/lib/search/sql-builder';

const OPS: BuilderOp[] = ['=', '!=', '>', '>=', '<', '<=', 'contains'];
const VALUE_TYPES: BuilderValueType[] = ['string', 'bool', 'real', 'int'];

export interface SearchModalSqlBuilderProps {
  /** Called when the user clicks "Use in Editor" — parent hands the
   *  generated SQL to the Editor and flips the mode. */
  onPromoteToEditor: (sql: string) => void;
  /** Called when the user clicks "Run" — parent executes the SQL and
   *  shares the result table. */
  onRun: (sql: string) => void;
  /** True while a run is in flight, disables the Run button. */
  running: boolean;
}

export function SearchModalSqlBuilder({
  onPromoteToEditor,
  onRun,
  running,
}: SearchModalSqlBuilderProps) {
  const {
    builder,
    models,
    activeModelId,
    setBuilderIfcType,
    setBuilderLimit,
    addBuilderFilter,
    updateBuilderFilter,
    removeBuilderFilter,
  } = useViewerStore(
    useShallow((s) => ({
      builder: s.searchSqlBuilder,
      models: s.models,
      activeModelId: s.activeModelId,
      setBuilderIfcType: s.setBuilderIfcType,
      setBuilderLimit: s.setBuilderLimit,
      addBuilderFilter: s.addBuilderFilter,
      updateBuilderFilter: s.updateBuilderFilter,
      removeBuilderFilter: s.removeBuilderFilter,
    })),
  );

  // Prefer the types the active model actually has over the hard-coded
  // starter list — users don't waste time picking IfcBeam in a house
  // model that doesn't contain any.
  const typeOptions = useMemo<string[]>(() => {
    const model = activeModelId ? models.get(activeModelId) : null;
    const byType = model?.ifcDataStore?.entityIndex?.byType;
    if (byType && byType.size > 0) {
      const names = Array.from(byType.keys())
        .map((upper) => upper.charAt(0) + upper.slice(1).toLowerCase())
        // UPPERCASE → PascalCase is approximate without the generated
        // name map, but IFC types are known-good ASCII so this produces
        // the canonical form for every common entity.
        .map((name) => name.replace(/^Ifc(.)/i, (_, c: string) => 'Ifc' + c.toUpperCase()))
        .sort();
      return Array.from(new Set(names));
    }
    return COMMON_IFC_TYPES.slice();
  }, [activeModelId, models]);

  const generatedSql = useMemo(() => generateSqlFromBuilder(builder), [builder]);

  const handleAddFilter = useCallback(() => {
    const defaultFilter: PropertyFilter = {
      psetName: '',
      propName: '',
      op: '=',
      valueType: 'string',
      value: '',
    };
    addBuilderFilter(defaultFilter);
  }, [addBuilderFilter]);

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-y-auto p-4 gap-4">
      {/* ── Type selector ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2 text-xs">
        <label className="w-24 shrink-0 font-semibold uppercase tracking-wider text-muted-foreground">
          Type
        </label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs font-mono">
              {builder.ifcType ?? 'Any'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            <DropdownMenuItem onSelect={() => setBuilderIfcType(null)}>
              <span className="italic text-muted-foreground">Any type</span>
            </DropdownMenuItem>
            {typeOptions.map((t) => (
              <DropdownMenuItem key={t} onSelect={() => setBuilderIfcType(t)} className="font-mono">
                {t}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {builder.ifcType && (
          <button
            type="button"
            onClick={() => setBuilderIfcType(null)}
            className="text-[10px] text-muted-foreground underline hover:text-foreground"
          >
            clear
          </button>
        )}
      </div>

      {/* ── Property filters ──────────────────────────────────────── */}
      <div className="flex items-start gap-2 text-xs">
        <label className="mt-1 w-24 shrink-0 font-semibold uppercase tracking-wider text-muted-foreground">
          Properties
        </label>
        <div className="flex-1 space-y-2">
          {builder.propertyFilters.length === 0 && (
            <p className="text-muted-foreground italic">
              No property filter — add one to query by Pset value.
            </p>
          )}
          {builder.propertyFilters.map((filter, i) => (
            <FilterRow
              key={i}
              index={i}
              filter={filter}
              onChange={(patch) => updateBuilderFilter(i, patch)}
              onRemove={() => removeBuilderFilter(i)}
            />
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAddFilter}
            className="h-7 gap-1 text-xs"
          >
            <Plus className="h-3 w-3" />
            Add property filter
          </Button>
        </div>
      </div>

      {/* ── Limit ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 text-xs">
        <label className="w-24 shrink-0 font-semibold uppercase tracking-wider text-muted-foreground">
          Limit
        </label>
        <Input
          type="number"
          min={0}
          value={builder.limit}
          onChange={(e) => setBuilderLimit(Number.parseInt(e.target.value, 10) || 0)}
          className="h-7 w-24 text-xs"
        />
        <span className="text-[11px] text-muted-foreground">0 = no limit</span>
      </div>

      {/* ── Generated SQL preview ─────────────────────────────────── */}
      <div className="mt-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Generated SQL
          </label>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPromoteToEditor(generatedSql)}
              disabled={!generatedSql}
              className="h-6 gap-1 text-[11px]"
            >
              Open in Editor
              <ArrowRight className="h-3 w-3" />
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => onRun(generatedSql)}
              disabled={!generatedSql || running}
              className="h-6 gap-1 text-[11px]"
            >
              {running ? 'Running…' : 'Run'}
            </Button>
          </div>
        </div>
        <pre className="whitespace-pre-wrap rounded border bg-zinc-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {generatedSql || (
            <span className="italic text-muted-foreground">
              Pick a type or add a filter to generate a query.
            </span>
          )}
        </pre>
      </div>
    </div>
  );
}

interface FilterRowProps {
  index: number;
  filter: PropertyFilter;
  onChange: (patch: Partial<PropertyFilter>) => void;
  onRemove: () => void;
}

function FilterRow({ filter, onChange, onRemove }: FilterRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded border border-zinc-200 bg-white px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-950">
      <Input
        placeholder="Pset (e.g. Pset_WallCommon)"
        value={filter.psetName}
        onChange={(e) => onChange({ psetName: e.target.value })}
        className="h-7 w-56 text-xs font-mono"
      />
      <span className="text-muted-foreground">.</span>
      <Input
        placeholder="Prop (e.g. IsExternal)"
        value={filter.propName}
        onChange={(e) => onChange({ propName: e.target.value })}
        className="h-7 w-44 text-xs font-mono"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 w-16 gap-1 text-xs font-mono">
            {filter.op}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {OPS.map((op) => (
            <DropdownMenuItem key={op} onSelect={() => onChange({ op })} className="font-mono">
              {op}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 w-20 gap-1 text-xs font-mono">
            {filter.valueType}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {VALUE_TYPES.map((t) => (
            <DropdownMenuItem key={t} onSelect={() => onChange({ valueType: t })} className="font-mono">
              {t}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {filter.valueType === 'bool' ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 w-24 gap-1 text-xs font-mono uppercase">
              {filter.value.toLowerCase() === 'true' ? 'true' : 'false'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => onChange({ value: 'true' })}>TRUE</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onChange({ value: 'false' })}>FALSE</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Input
          placeholder="value"
          value={filter.value}
          onChange={(e) => onChange({ value: e.target.value })}
          className="h-7 w-40 text-xs font-mono"
        />
      )}

      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove filter"
        className="ml-auto rounded p-1 text-muted-foreground hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-800"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
