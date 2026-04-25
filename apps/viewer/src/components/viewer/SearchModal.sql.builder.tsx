/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SearchModal.sql.builder — chip palette over the unified `FilterRule[]`.
 *
 * Builds rules for every kind in the discriminated union (storey,
 * ifcType, predefinedType, name, property, quantity) and compiles to
 * either DuckDB SQL (`generateSqlFromFilterRules`) or runs them through
 * the path-B in-memory evaluator (`evaluateFilterRulesFederated`) — the
 * parent `SearchModal.sql` decides which engine fires per click.
 *
 * Schema-aware dropdowns: storeys + ifcTypes load eagerly from the
 * active model's spatial hierarchy / entity index (cheap, ~ms). Pset /
 * qto names are loaded on demand the first time a property/quantity
 * rule is added, then cached in the slice for the model's lifetime.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, ArrowRight, Zap, Database, X, Bookmark, Save } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import {
  generateSqlFromFilterRules,
  isSqlSupported,
  COMMON_IFC_TYPES,
} from '@/lib/search/sql-builder';
import {
  Rule,
  type FilterRule,
  type SetOp,
  type StringOp,
  type ValueOp,
  type NumericOp,
  type Combinator,
} from '@/lib/search/filter-rules';
import {
  discoverFilterSchema,
  discoverPropertyAndQuantitySchema,
} from '@/lib/search/filter-schema';
import {
  loadSavedFilters,
  saveFilter,
  deleteSavedFilter,
  type SavedFilterPreset,
} from '@/lib/search/saved-filters';

// ── Op constants ──────────────────────────────────────────────────────

const SET_OPS: SetOp[] = ['in', 'notIn'];
const STRING_OPS: StringOp[] = ['eq', 'ne', 'contains', 'notContains', 'startsWith'];
const VALUE_OPS: ValueOp[] = [
  'eq', 'ne', 'contains', 'notContains', 'gt', 'gte', 'lt', 'lte', 'isSet', 'isNotSet',
];
const NUMERIC_OPS: NumericOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];

// Friendlier labels for the op dropdowns. The chip rendering keeps the
// canonical token so the generated SQL stays readable.
const OP_LABEL: Record<string, string> = {
  in: 'is one of',  notIn: 'is not one of',
  eq: '=', ne: '≠',
  contains: 'contains', notContains: 'does not contain',
  startsWith: 'starts with',
  gt: '>', gte: '≥', lt: '<', lte: '≤',
  isSet: 'is set', isNotSet: 'is not set',
};

const RULE_KIND_LABEL: Record<FilterRule['kind'], string> = {
  storey:          'Storey',
  ifcType:         'IFC Type',
  predefinedType:  'Predefined Type',
  name:            'Name',
  property:        'Property',
  quantity:        'Quantity',
};

export interface SearchModalSqlBuilderProps {
  /** Called when the user clicks "Open in Editor" — parent hands the
   *  generated SQL to the Editor and flips the mode. */
  onPromoteToEditor: (sql: string) => void;
  /** Run via DuckDB SQL. */
  onRunSql: (sql: string) => void;
  /** Run via the path-B in-memory evaluator (no DuckDB needed). */
  onRunFast: () => void;
  /** True while a run is in flight, disables both Run buttons. */
  running: boolean;
  /**
   * True when the optional `@duckdb/duckdb-wasm` package isn't
   * resolvable at runtime. Disables the SQL-emitter actions
   * (Run SQL + Open in Editor) and promotes Fast Run as the primary
   * action — Builder + Fast Run are entirely DuckDB-free. Defaults to
   * false so callers that don't probe availability still get the old
   * behaviour.
   */
  sqlUnavailable?: boolean;
}

export function SearchModalSqlBuilder({
  onPromoteToEditor,
  onRunSql,
  onRunFast,
  running,
  sqlUnavailable = false,
}: SearchModalSqlBuilderProps) {
  const {
    filter,
    schemaMap,
    models,
    activeModelId,
    searchQuery,
    setFilterCombinator,
    setFilterLimit,
    addFilterRule,
    updateFilterRule,
    removeFilterRule,
    clearFilterRules,
    setFilterSchema,
    setFilterPsetQtoSchema,
    setSearchFilter,
  } = useViewerStore(
    useShallow((s) => ({
      filter: s.searchFilter,
      schemaMap: s.searchFilterSchema,
      models: s.models,
      activeModelId: s.activeModelId,
      searchQuery: s.searchQuery,
      setFilterCombinator: s.setFilterCombinator,
      setFilterLimit: s.setFilterLimit,
      addFilterRule: s.addFilterRule,
      updateFilterRule: s.updateFilterRule,
      removeFilterRule: s.removeFilterRule,
      clearFilterRules: s.clearFilterRules,
      setFilterSchema: s.setFilterSchema,
      setFilterPsetQtoSchema: s.setFilterPsetQtoSchema,
      setSearchFilter: s.setSearchFilter,
    })),
  );

  // Saved filter presets — kept in component state so save/delete can
  // refresh the dropdown without a re-import. Loaded once on mount.
  const [savedPresets, setSavedPresets] = useState<SavedFilterPreset[]>(() => loadSavedFilters());

  const activeModel = activeModelId ? models.get(activeModelId) : undefined;
  const activeStore = activeModel?.ifcDataStore ?? null;
  const schemaEntry = activeModelId ? schemaMap.get(activeModelId) : undefined;

  // Cheap schema discovery — runs once per active model.
  useEffect(() => {
    if (!activeModelId || !activeStore) return;
    if (schemaMap.has(activeModelId)) return;
    const basic = discoverFilterSchema(activeStore);
    setFilterSchema(activeModelId, basic);
  }, [activeModelId, activeStore, schemaMap, setFilterSchema]);

  // Fallback IFC type list when no schema yet (e.g. server-loaded models
  // without the on-demand maps populated).
  const ifcTypeOptions = useMemo<string[]>(() => {
    if (schemaEntry?.basic.ifcTypes && schemaEntry.basic.ifcTypes.length > 0) {
      return schemaEntry.basic.ifcTypes;
    }
    return COMMON_IFC_TYPES.slice();
  }, [schemaEntry]);

  const storeyOptions = schemaEntry?.basic.storeys ?? [];

  // Lazy pset/qto schema — fired the first time a property or quantity
  // rule exists (or when the user clicks the "Refresh dropdowns" button).
  const ensurePsetQtoSchema = useCallback(() => {
    if (!activeModelId || !activeStore) return;
    const entry = schemaMap.get(activeModelId);
    if (entry?.psetQto) return;
    const psetQto = discoverPropertyAndQuantitySchema(activeStore);
    setFilterPsetQtoSchema(activeModelId, psetQto);
  }, [activeModelId, activeStore, schemaMap, setFilterPsetQtoSchema]);

  useEffect(() => {
    const needsSchema = filter.rules.some(
      (r) => r.kind === 'property' || r.kind === 'quantity',
    );
    if (needsSchema) ensurePsetQtoSchema();
  }, [filter.rules, ensurePsetQtoSchema]);

  const generatedSql = useMemo(
    () =>
      generateSqlFromFilterRules(filter.rules, {
        combinator: filter.combinator,
        limit: filter.limit,
      }),
    [filter.rules, filter.combinator, filter.limit],
  );

  // ── Rule construction handlers ──────────────────────────────────────

  const addRuleOfKind = useCallback((kind: FilterRule['kind']) => {
    let rule: FilterRule;
    switch (kind) {
      case 'storey':         rule = Rule.storey([], 'in'); break;
      case 'ifcType':        rule = Rule.ifcType([], 'in'); break;
      case 'predefinedType': rule = Rule.predefinedType([], 'in'); break;
      case 'name':           rule = Rule.name('contains', ''); break;
      case 'property':       rule = Rule.property('', '', 'eq', ''); break;
      case 'quantity':       rule = Rule.quantity('', '', 'gt', 0); break;
    }
    addFilterRule(rule);
  }, [addFilterRule]);

  const promoteSearchQuery = useCallback(() => {
    const q = searchQuery.trim();
    if (!q) return;
    addFilterRule(Rule.name('contains', q));
  }, [addFilterRule, searchQuery]);

  // ── Preset handlers ─────────────────────────────────────────────────

  const handleSavePreset = useCallback(() => {
    if (filter.rules.length === 0) return;
    // Browser prompt is fine here — the chip builder is already a modal
    // dialog, and a nested dialog feels overkill for a one-line input.
    // eslint-disable-next-line no-alert
    const name = window.prompt('Save filter as…', '');
    if (!name) return;
    const next = saveFilter(name, filter.combinator, filter.rules);
    setSavedPresets(next);
  }, [filter.combinator, filter.rules]);

  const handleLoadPreset = useCallback((preset: SavedFilterPreset) => {
    setSearchFilter({
      rules: preset.rules.map((r) => ({ ...r }) as FilterRule),
      combinator: preset.combinator,
      limit: filter.limit,
    });
  }, [filter.limit, setSearchFilter]);

  const handleDeletePreset = useCallback((name: string) => {
    const next = deleteSavedFilter(name);
    setSavedPresets(next);
  }, []);

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-y-auto p-4 gap-3">
      {/* ── Toolbar: AND/OR, Limit, Reset, optional inline-query bridge ── */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <CombinatorToggle value={filter.combinator} onChange={setFilterCombinator} />

        <div className="ml-1 flex items-center gap-1">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Limit
          </label>
          <Input
            type="number"
            min={0}
            value={filter.limit}
            onChange={(e) => setFilterLimit(Number.parseInt(e.target.value, 10) || 0)}
            className="h-7 w-20 text-xs"
          />
          <span className="text-[10px] text-muted-foreground">0 = none</span>
        </div>

        {searchQuery.trim().length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={promoteSearchQuery}
            className="h-7 gap-1 text-[11px]"
            title="Add a Name contains rule from the search bar query"
          >
            <Plus className="h-3 w-3" />
            Add &ldquo;{truncate(searchQuery.trim(), 18)}&rdquo; as Name rule
          </Button>
        )}

        <div className="ml-auto flex items-center gap-1">
          <PresetMenu
            presets={savedPresets}
            onLoad={handleLoadPreset}
            onDelete={handleDeletePreset}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleSavePreset}
            disabled={filter.rules.length === 0}
            className="h-7 gap-1 text-[11px]"
            title="Save the current rules as a named preset"
          >
            <Save className="h-3 w-3" /> Save
          </Button>
          {filter.rules.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearFilterRules}
              className="h-7 gap-1 text-[11px] text-muted-foreground"
            >
              <X className="h-3 w-3" /> Reset rules
            </Button>
          )}
        </div>
      </div>

      {/* ── Rules list ──────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        {filter.rules.length === 0 && (
          <p className="rounded border border-dashed border-zinc-300 bg-zinc-50 px-3 py-3 text-center text-xs italic text-muted-foreground dark:border-zinc-800 dark:bg-zinc-900/30">
            No rules — click &ldquo;Add rule&rdquo; below or use the search-bar bridge above.
          </p>
        )}
        {filter.rules.map((rule, i) => (
          <RuleRow
            key={i}
            rule={rule}
            ifcTypeOptions={ifcTypeOptions}
            storeyOptions={storeyOptions}
            psetQto={schemaEntry?.psetQto ?? null}
            onChange={(next) => updateFilterRule(i, next)}
            onRemove={() => removeFilterRule(i)}
          />
        ))}

        <AddRuleMenu onAdd={addRuleOfKind} />
      </div>

      {/* ── Generated SQL preview + actions ────────────────────────────── */}
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
              disabled={!generatedSql || sqlUnavailable}
              className="h-6 gap-1 text-[11px]"
              title={sqlUnavailable
                ? 'SQL Editor needs @duckdb/duckdb-wasm — install it to enable'
                : 'Copy generated SQL into the Editor tab'}
            >
              Open in Editor
              <ArrowRight className="h-3 w-3" />
            </Button>
            {/* When DuckDB-WASM isn't installed, Fast Run becomes the
                primary action — visually default-styled and the only
                usable run path. Run SQL stays in the layout but disabled,
                so the keyboard order / muscle memory doesn't shift when
                the optional package gets installed later. */}
            <Button
              variant={sqlUnavailable ? 'default' : 'outline'}
              size="sm"
              onClick={onRunFast}
              disabled={filter.rules.length === 0 || running}
              className="h-6 gap-1 text-[11px]"
              title="Run rules through the in-memory evaluator (no DuckDB needed, faster for small candidate sets)"
            >
              <Zap className="h-3 w-3" />
              {running && sqlUnavailable ? 'Running…' : 'Fast Run'}
            </Button>
            <Button
              variant={sqlUnavailable ? 'outline' : 'default'}
              size="sm"
              onClick={() => onRunSql(generatedSql)}
              disabled={!generatedSql || running || sqlUnavailable}
              className="h-6 gap-1 text-[11px]"
              title={sqlUnavailable
                ? 'Run SQL needs @duckdb/duckdb-wasm — use Fast Run instead'
                : 'Compile rules to SQL and run via DuckDB'}
            >
              <Database className="h-3 w-3" />
              {running && !sqlUnavailable ? 'Running…' : 'Run SQL'}
            </Button>
          </div>
        </div>
        <pre className="whitespace-pre-wrap rounded border bg-zinc-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {generatedSql || (
            <span className="italic text-muted-foreground">
              Add a rule to generate a query.
            </span>
          )}
        </pre>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function CombinatorToggle({
  value,
  onChange,
}: {
  value: Combinator;
  onChange: (next: Combinator) => void;
}) {
  return (
    <div className="inline-flex rounded border border-zinc-200 bg-white p-0.5 text-[11px] dark:border-zinc-800 dark:bg-zinc-950">
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

function PresetMenu({
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
        <DropdownMenuLabel className="text-[10px] uppercase">Saved filter presets</DropdownMenuLabel>
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

function AddRuleMenu({
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

interface RuleRowProps {
  rule: FilterRule;
  ifcTypeOptions: string[];
  storeyOptions: ReadonlyArray<readonly [string, number | null]>;
  psetQto: { psets: ReadonlyArray<readonly [string, ReadonlyArray<string>]>; qtos: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> } | null;
  onChange: (next: FilterRule) => void;
  onRemove: () => void;
}

function RuleRow({ rule, ifcTypeOptions, storeyOptions, psetQto, onChange, onRemove }: RuleRowProps) {
  const sqlSupported = isSqlSupported(rule);
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded border border-zinc-200 bg-white px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-950">
      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
        {RULE_KIND_LABEL[rule.kind]}
      </span>
      {!sqlSupported && (
        <span
          className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
          title="DuckDB schema doesn't expose this column — Run SQL will skip this rule. Use Fast Run instead."
        >
          Fast Run only
        </span>
      )}

      {rule.kind === 'storey' && (
        <SetRuleEditor
          values={rule.values}
          op={rule.op}
          options={storeyOptions.map(([name, elev]) => ({
            label: elev != null ? `${name} (${elev.toFixed(2)} m)` : name,
            value: name,
          }))}
          onChange={(values, op) => onChange(Rule.storey(values, op))}
        />
      )}

      {rule.kind === 'ifcType' && (
        <SetRuleEditor
          values={rule.values}
          op={rule.op}
          options={ifcTypeOptions.map((t) => ({ label: t, value: t }))}
          onChange={(values, op) => onChange(Rule.ifcType(values, op))}
        />
      )}

      {rule.kind === 'predefinedType' && (
        <PredefinedTypeEditor
          values={rule.values}
          op={rule.op}
          onChange={(values, op) => onChange(Rule.predefinedType(values, op))}
        />
      )}

      {rule.kind === 'name' && (
        <NameEditor
          op={rule.op}
          value={rule.value}
          onChange={(op, value) => onChange(Rule.name(op, value))}
        />
      )}

      {rule.kind === 'property' && (
        <PropertyEditor
          rule={rule}
          psetQto={psetQto}
          onChange={onChange}
        />
      )}

      {rule.kind === 'quantity' && (
        <QuantityEditor
          rule={rule}
          psetQto={psetQto}
          onChange={onChange}
        />
      )}

      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove rule"
        className="ml-auto rounded p-1 text-muted-foreground hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-800"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

// ── Per-kind editors ──────────────────────────────────────────────────

interface SetRuleEditorProps {
  values: string[];
  op: SetOp;
  options: Array<{ label: string; value: string }>;
  onChange: (values: string[], op: SetOp) => void;
}

function SetRuleEditor({ values, op, options, onChange }: SetRuleEditorProps) {
  const toggle = (v: string) => {
    const next = values.includes(v) ? values.filter((x) => x !== v) : [...values, v];
    onChange(next, op);
  };
  return (
    <>
      <OpDropdown ops={SET_OPS} value={op} onChange={(next) => onChange(values, next)} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs font-mono">
            {values.length === 0 ? 'Pick values…' : `${values.length} selected`}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          {options.length === 0 && (
            <DropdownMenuItem disabled className="text-muted-foreground italic">
              No options available — type appears once a model is loaded.
            </DropdownMenuItem>
          )}
          {options.map((o) => (
            <DropdownMenuItem
              key={o.value}
              onSelect={(e) => {
                // Keep the menu open for multi-select.
                e.preventDefault();
                toggle(o.value);
              }}
              className="font-mono"
            >
              <span className="mr-2 inline-block w-3 text-center">
                {values.includes(o.value) ? '✓' : ''}
              </span>
              {o.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {values.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-mono dark:bg-zinc-800"
            >
              {v}
              <button
                type="button"
                aria-label={`Remove ${v}`}
                onClick={() => toggle(v)}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function PredefinedTypeEditor({
  values,
  op,
  onChange,
}: {
  values: string[];
  op: SetOp;
  onChange: (values: string[], op: SetOp) => void;
}) {
  // Predefined types aren't materialised in the parser today — pick
  // them via free-text. The user enters comma-separated values.
  const text = values.join(', ');
  return (
    <>
      <OpDropdown ops={SET_OPS} value={op} onChange={(next) => onChange(values, next)} />
      <Input
        placeholder="e.g. SOLIDWALL, PARTITIONING"
        value={text}
        onChange={(e) =>
          onChange(
            e.target.value.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
            op,
          )
        }
        className="h-7 w-72 text-xs font-mono"
      />
    </>
  );
}

function NameEditor({
  op,
  value,
  onChange,
}: {
  op: StringOp;
  value: string;
  onChange: (op: StringOp, value: string) => void;
}) {
  return (
    <>
      <OpDropdown ops={STRING_OPS} value={op} onChange={(next) => onChange(next, value)} />
      <Input
        placeholder="text"
        value={value}
        onChange={(e) => onChange(op, e.target.value)}
        className="h-7 w-56 text-xs font-mono"
      />
    </>
  );
}

interface PropertyEditorProps {
  rule: Extract<FilterRule, { kind: 'property' }>;
  psetQto: RuleRowProps['psetQto'];
  onChange: (next: FilterRule) => void;
}

function PropertyEditor({ rule, psetQto, onChange }: PropertyEditorProps) {
  const psetNames = useMemo(() => (psetQto ? psetQto.psets.map(([n]) => n) : []), [psetQto]);
  const propNames = useMemo(() => {
    if (!psetQto) return [];
    const entry = psetQto.psets.find(([n]) => n === rule.setName);
    return entry ? Array.from(entry[1]) : [];
  }, [psetQto, rule.setName]);

  const valueless = rule.op === 'isSet' || rule.op === 'isNotSet';

  return (
    <>
      <FreeOrPickInput
        placeholder="Pset_… (e.g. Pset_WallCommon)"
        value={rule.setName}
        options={psetNames}
        widthClass="w-52"
        onChange={(next) => onChange({ ...rule, setName: next, propertyName: '' })}
      />
      <span className="text-muted-foreground">.</span>
      <FreeOrPickInput
        placeholder="prop name"
        value={rule.propertyName}
        options={propNames}
        widthClass="w-44"
        onChange={(next) => onChange({ ...rule, propertyName: next })}
      />
      <OpDropdown ops={VALUE_OPS} value={rule.op} onChange={(next) => onChange({ ...rule, op: next })} />
      {!valueless && (
        <Input
          placeholder="value"
          value={rule.value}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          className="h-7 w-40 text-xs font-mono"
        />
      )}
    </>
  );
}

interface QuantityEditorProps {
  rule: Extract<FilterRule, { kind: 'quantity' }>;
  psetQto: RuleRowProps['psetQto'];
  onChange: (next: FilterRule) => void;
}

function QuantityEditor({ rule, psetQto, onChange }: QuantityEditorProps) {
  const qsetNames = useMemo(() => (psetQto ? psetQto.qtos.map(([n]) => n) : []), [psetQto]);
  const qtyNames = useMemo(() => {
    if (!psetQto) return [];
    const entry = psetQto.qtos.find(([n]) => n === rule.setName);
    return entry ? entry[1].map(([n]) => n) : [];
  }, [psetQto, rule.setName]);

  return (
    <>
      <FreeOrPickInput
        placeholder="Qto_… (e.g. Qto_WallBaseQuantities)"
        value={rule.setName}
        options={qsetNames}
        widthClass="w-56"
        onChange={(next) => onChange({ ...rule, setName: next, quantityName: '' })}
      />
      <span className="text-muted-foreground">.</span>
      <FreeOrPickInput
        placeholder="quantity name"
        value={rule.quantityName}
        options={qtyNames}
        widthClass="w-44"
        onChange={(next) => onChange({ ...rule, quantityName: next })}
      />
      <OpDropdown ops={NUMERIC_OPS} value={rule.op} onChange={(next) => onChange({ ...rule, op: next })} />
      <Input
        type="number"
        placeholder="value"
        value={rule.value}
        onChange={(e) => onChange({ ...rule, value: Number.parseFloat(e.target.value) || 0 })}
        className="h-7 w-32 text-xs font-mono"
      />
    </>
  );
}

// ── Building-block widgets ───────────────────────────────────────────

function OpDropdown<T extends string>({
  ops,
  value,
  onChange,
}: {
  ops: ReadonlyArray<T>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 min-w-[3.5rem] gap-1 text-xs font-mono">
          {OP_LABEL[value] ?? value}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {ops.map((op) => (
          <DropdownMenuItem key={op} onSelect={() => onChange(op)} className="font-mono">
            {OP_LABEL[op] ?? op}
            <span className="ml-2 text-[10px] text-muted-foreground">{op}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Free-text input that exposes a small dropdown of known options when
 * the schema knows them. The user can either pick from the menu or type
 * a value not present in the schema (useful for typos / new psets).
 */
function FreeOrPickInput({
  placeholder,
  value,
  options,
  widthClass,
  onChange,
}: {
  placeholder: string;
  value: string;
  options: ReadonlyArray<string>;
  widthClass: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="relative inline-flex items-center gap-1">
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-7 ${widthClass} text-xs font-mono`}
      />
      {options.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-1 text-[10px] text-muted-foreground" title="Pick from schema">
              ▾
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {options.map((o) => (
              <DropdownMenuItem key={o} onSelect={() => onChange(o)} className="font-mono">
                {o}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
