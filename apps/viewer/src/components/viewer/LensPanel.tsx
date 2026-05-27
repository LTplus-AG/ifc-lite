/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lens panel — rule-based 3D filtering and coloring
 *
 * Shows saved lens presets and allows activating/deactivating them.
 * Users can create, edit, and delete custom lenses with full rule editing.
 * Supports both manual rule-based lenses and auto-color lenses that
 * automatically color entities by distinct values of any IFC data column.
 * When a lens is active, a color legend displays the matched rules/values.
 * Unmatched entities are ghosted (semi-transparent) for visual context.
 *
 * All dropdowns are populated dynamically from the loaded model data
 * via discoveredLensData (IFC types, property sets, quantity sets,
 * classification systems, materials). No hardcoded IFC class lists.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, EyeOff, Palette, Check, Plus, Trash2, Pencil, Save, Download, Upload, Sparkles, Search, ChevronDown, ArrowUpDown } from 'lucide-react';
import { discoverDataSources } from '@ifc-lite/lens';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { useLens } from '@/hooks/useLens';
import { createLensDataProvider } from '@/lib/lens';
import type { Lens, LensRule, LensCriteria, AutoColorSpec, AutoColorLegendEntry, DiscoveredLensData } from '@/store/slices/lensSlice';
import {
  LENS_PALETTE, ENTITY_ATTRIBUTE_NAMES, AUTO_COLOR_SOURCES,
} from '@/store/slices/lensSlice';

/** Format large counts compactly: 1234 → "1.2k" */
function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/** Human-readable label for source / criteria types (shared) */
const TYPE_LABELS: Record<string, string> = {
  ifcType: 'IFC Class',
  attribute: 'Attribute',
  property: 'Property',
  quantity: 'Quantity',
  classification: 'Classification',
  material: 'Material',
  model: 'Model',
};

interface LensPanelProps {
  onClose?: () => void;
}

// ─── Searchable dropdown (for large dynamic lists) ──────────────────────────

function SearchableSelect({
  value,
  options,
  onChange,
  placeholder,
  className,
  displayFn,
}: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  displayFn?: (v: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!filter) return options;
    const q = filter.toLowerCase();
    return options.filter(o => o.toLowerCase().includes(q));
  }, [options, filter]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilter('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const display = displayFn ?? ((v: string) => v);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!open) setTimeout(() => inputRef.current?.focus(), 0);
        }}
        className={cn(
          'w-full flex items-center justify-between gap-1 text-left',
          'text-xs px-1.5 py-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm',
          !value && 'text-zinc-400 dark:text-zinc-500',
        )}
      >
        <span className="truncate">{value ? display(value) : (placeholder ?? 'Select...')}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-50" />
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-0.5 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded-sm shadow-lg max-h-[200px] flex flex-col">
          {options.length > 8 && (
            <div className="flex items-center gap-1 px-1.5 py-1 border-b border-zinc-200 dark:border-zinc-700">
              <Search className="h-3 w-3 text-zinc-400 flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search..."
                className="flex-1 text-xs bg-transparent border-0 outline-none text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
              />
            </div>
          )}
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-zinc-400">No matches</div>
            )}
            {filtered.map(opt => (
              <button
                key={opt}
                type="button"
                className={cn(
                  'w-full text-left px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 truncate',
                  opt === value && 'bg-primary/10 text-primary font-medium',
                )}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                  setFilter('');
                }}
              >
                {display(opt)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Rule display (read-only, clickable for isolation) ──────────────────────

const RuleRow = memo(function RuleRow({
  rule,
  count,
  isIsolated,
  onClick,
}: {
  rule: LensRule;
  count: number;
  isIsolated?: boolean;
  onClick?: () => void;
}) {
  const isEmpty = count === 0;
  const isClickable = !!onClick && !isEmpty;

  return (
    <div
      className={cn(
        'group/row relative flex items-center gap-2 pl-3 pr-3 py-1.5 text-xs',
        'border-l-2 transition-[border-color,background-color] duration-100',
        !rule.enabled && 'opacity-40',
        !isIsolated && !isEmpty && 'border-l-transparent',
        isClickable && 'cursor-pointer hover:border-l-primary/70 hover:bg-zinc-100/80 dark:hover:bg-zinc-700/40',
        isIsolated && 'border-l-primary bg-primary/8 dark:bg-primary/15',
        isEmpty && 'border-l-transparent opacity-50 cursor-default',
      )}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={(e) => { if (isClickable) { e.stopPropagation(); onClick(); } }}
      onKeyDown={(e) => { if (isClickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}
      title={isClickable ? 'Click to isolate / show only this group' : isEmpty ? 'No matching entities' : undefined}
    >
      <div
        className={cn(
          'w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/10 dark:ring-white/20',
          isEmpty && 'grayscale',
        )}
        style={{ backgroundColor: rule.color }}
      />
      <span className={cn(
        'flex-1 truncate font-medium',
        isIsolated
          ? 'text-zinc-900 dark:text-zinc-50'
          : isEmpty
            ? 'text-zinc-400 dark:text-zinc-600'
            : 'text-zinc-900 dark:text-zinc-50',
      )}>
        {rule.name}
      </span>
      {isIsolated && (
        <span className="text-[10px] uppercase tracking-wider font-bold text-primary">
          isolated
        </span>
      )}
      <span className={cn(
        'text-[10px] tabular-nums font-mono min-w-[2ch] text-right',
        isEmpty
          ? 'text-zinc-300 dark:text-zinc-700'
          : 'text-zinc-400 dark:text-zinc-500',
      )}>
        {isEmpty ? '—' : formatCount(count)}
      </span>
    </div>
  );
});

// ─── Auto-color legend row (read-only, clickable for isolation) ─────────────

const AutoColorRow = memo(function AutoColorRow({
  entry,
  isIsolated,
  onClick,
}: {
  entry: AutoColorLegendEntry;
  isIsolated?: boolean;
  onClick?: () => void;
}) {
  const isEmpty = entry.count === 0;
  const isClickable = !!onClick && !isEmpty;

  return (
    <div
      className={cn(
        'group/row relative flex items-center gap-2 pl-3 pr-3 py-1.5 text-xs',
        'border-l-2 transition-[border-color,background-color] duration-100',
        !isIsolated && !isEmpty && 'border-l-transparent',
        isClickable && 'cursor-pointer hover:border-l-primary/70 hover:bg-zinc-100/80 dark:hover:bg-zinc-700/40',
        isIsolated && 'border-l-primary bg-primary/8 dark:bg-primary/15',
        isEmpty && 'border-l-transparent opacity-50 cursor-default',
      )}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={(e) => { if (isClickable) { e.stopPropagation(); onClick(); } }}
      onKeyDown={(e) => { if (isClickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}
      title={isClickable ? 'Click to isolate / show only this value' : undefined}
    >
      <div
        className="w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/10 dark:ring-white/20"
        style={{ backgroundColor: entry.color }}
      />
      <span className="flex-1 truncate font-medium text-zinc-900 dark:text-zinc-50">
        {entry.name}
      </span>
      {isIsolated && (
        <span className="text-[10px] uppercase tracking-wider font-bold text-primary">
          isolated
        </span>
      )}
      <span className="text-[10px] tabular-nums font-mono min-w-[2ch] text-right text-zinc-400 dark:text-zinc-500">
        {formatCount(entry.count)}
      </span>
    </div>
  );
});

// ─── Rule editor (inline editing with criteria type selector) ────────────────

function RuleEditor({
  rule,
  onChange,
  onRemove,
  discovered,
  onRequestDiscovery,
}: {
  rule: LensRule;
  onChange: (patch: Partial<LensRule>) => void;
  onRemove: () => void;
  discovered: DiscoveredLensData | null;
  onRequestDiscovery: (categories: { properties?: boolean; quantities?: boolean; classifications?: boolean; materials?: boolean }) => void;
}) {
  const criteriaType = rule.criteria.type;
  const loadedModels = useViewerStore((s) => s.models);
  const modelOptions = useMemo(
    () => Array.from(loadedModels.values()).sort((a, b) => a.name.localeCompare(b.name)),
    [loadedModels],
  );

  // Trigger lazy discovery when user selects a criteria type that needs it
  useEffect(() => {
    if (!discovered) return;
    if (criteriaType === 'property' && !discovered.propertySets) {
      onRequestDiscovery({ properties: true });
    } else if (criteriaType === 'quantity' && !discovered.quantitySets) {
      onRequestDiscovery({ quantities: true });
    } else if (criteriaType === 'classification' && !discovered.classificationSystems) {
      onRequestDiscovery({ classifications: true });
    } else if (criteriaType === 'material' && !discovered.materials) {
      onRequestDiscovery({ materials: true });
    }
  }, [criteriaType, discovered, onRequestDiscovery]);

  // Derived lists from discovered data
  const ifcClasses = useMemo(() => discovered?.classes ?? [], [discovered]);
  const psetNames = useMemo((): string[] => {
    if (!discovered?.propertySets) return [];
    return Array.from(discovered.propertySets.keys()).sort();
  }, [discovered]);
  const selectedPsetProps = useMemo(() => {
    if (!discovered?.propertySets || !rule.criteria.propertySet) return [];
    return discovered.propertySets.get(rule.criteria.propertySet) ?? [];
  }, [discovered, rule.criteria.propertySet]);
  const qsetNames = useMemo((): string[] => {
    if (!discovered?.quantitySets) return [];
    return Array.from(discovered.quantitySets.keys()).sort();
  }, [discovered]);
  const selectedQsetQuants = useMemo(() => {
    if (!discovered?.quantitySets || !rule.criteria.quantitySet) return [];
    return discovered.quantitySets.get(rule.criteria.quantitySet) ?? [];
  }, [discovered, rule.criteria.quantitySet]);
  const classificationSystems = useMemo(() => discovered?.classificationSystems ?? [], [discovered]);
  const materialNames = useMemo(() => discovered?.materials ?? [], [discovered]);

  const handleCriteriaTypeChange = (newType: LensCriteria['type']) => {
    const base: LensCriteria = { type: newType };
    switch (newType) {
      case 'ifcType':
        base.ifcType = '';
        break;
      case 'attribute':
        base.attributeName = 'Name';
        base.operator = 'contains';
        base.attributeValue = '';
        break;
      case 'property':
        base.propertySet = '';
        base.propertyName = '';
        base.operator = 'contains';
        base.propertyValue = '';
        break;
      case 'quantity':
        base.quantitySet = '';
        base.quantityName = '';
        base.operator = 'exists';
        break;
      case 'classification':
        base.classificationSystem = '';
        base.classificationCode = '';
        break;
      case 'material':
        base.materialName = '';
        break;
      case 'model':
        base.modelId = modelOptions.length === 1 ? modelOptions[0].id : '';
        break;
    }
    onChange({ criteria: base, name: rule.name === 'New Rule' ? TYPE_LABELS[newType] : rule.name });
  };

  /** Derive a human-readable name from the criteria */
  const deriveRuleName = (criteria: LensCriteria): string => {
    switch (criteria.type) {
      case 'ifcType': return criteria.ifcType ? criteria.ifcType.replace('Ifc', '') : 'New Rule';
      case 'attribute': return criteria.attributeValue || criteria.attributeName || 'Attribute';
      case 'property': return criteria.propertyName || 'Property';
      case 'quantity': return criteria.quantityName || 'Quantity';
      case 'classification': return criteria.classificationCode || criteria.classificationSystem || 'Classification';
      case 'material': return criteria.materialName || 'Material';
      case 'model': {
        const selected = modelOptions.find(m => m.id === criteria.modelId);
        return selected?.name || 'Model';
      }
      default: return 'Rule';
    }
  };

  const selectClass = 'text-xs px-1.5 py-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm';
  const inputClass = 'text-xs px-1.5 py-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm';

  return (
    <div className="px-2 py-1.5 space-y-1">
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={rule.color}
          onChange={(e) => onChange({ color: e.target.value })}
          className="w-6 h-6 cursor-pointer border-0 p-0 bg-transparent flex-shrink-0 rounded"
        />
        {/* Criteria type selector */}
        <select
          value={criteriaType}
          onChange={(e) => handleCriteriaTypeChange(e.target.value as LensCriteria['type'])}
          className={cn(selectClass, 'w-[90px]')}
        >
          {Object.entries(TYPE_LABELS).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>

        {/* IFC Class: searchable dropdown from discovered classes */}
        {criteriaType === 'ifcType' && (
          <SearchableSelect
            value={rule.criteria.ifcType ?? ''}
            options={ifcClasses}
            onChange={(ifcType) => {
              onChange({
                criteria: { ...rule.criteria, ifcType },
                name: ifcType ? ifcType.replace('Ifc', '') : rule.name,
              });
            }}
            placeholder="Class..."
            className="flex-1 min-w-0"
            displayFn={(v) => v.replace('Ifc', '')}
          />
        )}

        {/* Attribute: dropdown for name, text input for value */}
        {criteriaType === 'attribute' && (
          <>
            <select
              value={rule.criteria.attributeName ?? 'Name'}
              onChange={(e) => {
                const updated = { ...rule.criteria, attributeName: e.target.value };
                onChange({ criteria: updated, name: deriveRuleName(updated) });
              }}
              className={cn(selectClass, 'w-[80px]')}
            >
              {ENTITY_ATTRIBUTE_NAMES.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <input
              type="text"
              value={rule.criteria.attributeValue ?? ''}
              onChange={(e) => {
                const updated = { ...rule.criteria, attributeValue: e.target.value };
                onChange({ criteria: updated, name: deriveRuleName(updated) });
              }}
              placeholder="value..."
              className={cn(inputClass, 'flex-1 min-w-0')}
            />
          </>
        )}

        {/* Property: searchable dropdowns for pset + property name */}
        {criteriaType === 'property' && (
          <>
            <SearchableSelect
              value={rule.criteria.propertySet ?? ''}
              options={psetNames}
              onChange={(pset) => onChange({ criteria: { ...rule.criteria, propertySet: pset, propertyName: '' } })}
              placeholder="Pset..."
              className="w-[100px]"
            />
            <SearchableSelect
              value={rule.criteria.propertyName ?? ''}
              options={selectedPsetProps}
              onChange={(prop) => {
                const updated = { ...rule.criteria, propertyName: prop };
                onChange({ criteria: updated, name: deriveRuleName(updated) });
              }}
              placeholder="Prop..."
              className="flex-1 min-w-0"
            />
          </>
        )}

        {/* Quantity: searchable dropdowns for qset + quantity name */}
        {criteriaType === 'quantity' && (
          <>
            <SearchableSelect
              value={rule.criteria.quantitySet ?? ''}
              options={qsetNames}
              onChange={(qset) => onChange({ criteria: { ...rule.criteria, quantitySet: qset, quantityName: '' } })}
              placeholder="Qset..."
              className="w-[100px]"
            />
            <SearchableSelect
              value={rule.criteria.quantityName ?? ''}
              options={selectedQsetQuants}
              onChange={(qty) => {
                const updated = { ...rule.criteria, quantityName: qty };
                onChange({ criteria: updated, name: deriveRuleName(updated) });
              }}
              placeholder="Qty..."
              className="flex-1 min-w-0"
            />
          </>
        )}

        {/* Classification: searchable dropdown for system, text input for code */}
        {criteriaType === 'classification' && (
          <>
            <SearchableSelect
              value={rule.criteria.classificationSystem ?? ''}
              options={classificationSystems}
              onChange={(sys) => onChange({ criteria: { ...rule.criteria, classificationSystem: sys } })}
              placeholder="System..."
              className="w-[100px]"
            />
            <input
              type="text"
              value={rule.criteria.classificationCode ?? ''}
              onChange={(e) => {
                const updated = { ...rule.criteria, classificationCode: e.target.value };
                onChange({ criteria: updated, name: deriveRuleName(updated) });
              }}
              placeholder="Code..."
              className={cn(inputClass, 'flex-1 min-w-0')}
            />
          </>
        )}

        {/* Material: searchable dropdown from discovered materials */}
        {criteriaType === 'material' && (
          <SearchableSelect
            value={rule.criteria.materialName ?? ''}
            options={materialNames}
            onChange={(mat) => {
              const updated = { ...rule.criteria, materialName: mat };
              onChange({ criteria: updated, name: deriveRuleName(updated) });
            }}
            placeholder="Material..."
            className="flex-1 min-w-0"
          />
        )}

        {/* Model: dropdown from loaded federated models */}
        {criteriaType === 'model' && (
          modelOptions.length <= 1 ? (
            <span className="flex-1 min-w-0 text-xs text-zinc-400 dark:text-zinc-500 truncate">
              {modelOptions.length === 0 ? 'No models loaded' : modelOptions[0]?.name ?? 'Model'}
            </span>
          ) : (
            <select
              value={rule.criteria.modelId ?? ''}
              onChange={(e) => {
                const modelId = e.target.value;
                const updated = { ...rule.criteria, modelId };
                onChange({ criteria: updated, name: deriveRuleName(updated) });
              }}
              className={cn(selectClass, 'flex-1 min-w-0')}
            >
              <option value="">Model...</option>
              {modelOptions.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          )
        )}

        <button
          onClick={onRemove}
          className="text-zinc-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400 p-0.5 flex-shrink-0"
          title="Remove rule"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Second row: operator + value for property/quantity/attribute */}
      {(criteriaType === 'property' || criteriaType === 'quantity') && (
        <div className="flex items-center gap-1.5 pl-[30px]">
          <select
            value={rule.criteria.operator ?? 'exists'}
            onChange={(e) => onChange({ criteria: { ...rule.criteria, operator: e.target.value as LensCriteria['operator'] } })}
            className={cn(selectClass, 'w-[80px]')}
          >
            <option value="exists">Exists</option>
            <option value="equals">Equals</option>
            <option value="contains">Contains</option>
          </select>
          {rule.criteria.operator && rule.criteria.operator !== 'exists' && (
            <input
              type="text"
              value={
                criteriaType === 'property'
                  ? (rule.criteria.propertyValue ?? '')
                  : (rule.criteria.quantityValue ?? '')
              }
              onChange={(e) => {
                const key = criteriaType === 'property' ? 'propertyValue' : 'quantityValue';
                onChange({ criteria: { ...rule.criteria, [key]: e.target.value } });
              }}
              placeholder="Value..."
              className={cn(inputClass, 'flex-1 min-w-0')}
            />
          )}
          <select
            value={rule.action}
            onChange={(e) => onChange({ action: e.target.value as LensRule['action'] })}
            className={cn(selectClass, 'w-[72px]')}
          >
            <option value="colorize">Color</option>
            <option value="transparent">Transp</option>
            <option value="hide">Hide</option>
          </select>
        </div>
      )}

      {/* Action selector for simple types */}
      {criteriaType !== 'property' && criteriaType !== 'quantity' && (
        <div className="flex items-center gap-1.5 pl-[30px]">
          {criteriaType === 'attribute' && (
            <select
              value={rule.criteria.operator ?? 'contains'}
              onChange={(e) => onChange({ criteria: { ...rule.criteria, operator: e.target.value as LensCriteria['operator'] } })}
              className={cn(selectClass, 'w-[80px]')}
            >
              <option value="equals">Equals</option>
              <option value="contains">Contains</option>
              <option value="exists">Exists</option>
            </select>
          )}
          <select
            value={rule.action}
            onChange={(e) => onChange({ action: e.target.value as LensRule['action'] })}
            className={cn(selectClass, 'w-[72px]')}
          >
            <option value="colorize">Color</option>
            <option value="transparent">Transp</option>
            <option value="hide">Hide</option>
          </select>
        </div>
      )}
    </div>
  );
}

// ─── Lens editor (create/edit mode) ─────────────────────────────────────────

function LensEditor({
  initial,
  onSave,
  onCancel,
  discovered,
  onRequestDiscovery,
}: {
  initial: Lens;
  onSave: (lens: Lens) => void;
  onCancel: () => void;
  discovered: DiscoveredLensData | null;
  onRequestDiscovery: (categories: { properties?: boolean; quantities?: boolean; classifications?: boolean; materials?: boolean }) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [rules, setRules] = useState<LensRule[]>(() =>
    initial.rules.map(r => ({ ...r })),
  );

  const addRule = () => {
    const colorIndex = rules.length % LENS_PALETTE.length;
    setRules([...rules, {
      id: `rule-${Date.now()}-${rules.length}`,
      name: 'New Rule',
      enabled: true,
      criteria: { type: 'ifcType', ifcType: '' },
      action: 'colorize',
      color: LENS_PALETTE[colorIndex],
    }]);
  };

  const updateRule = (index: number, patch: Partial<LensRule>) => {
    setRules(rules.map((r, i) => i === index ? { ...r, ...patch } : r));
  };

  const removeRule = (index: number) => {
    setRules(rules.filter((_, i) => i !== index));
  };

  /** Check if a rule has sufficient criteria to be valid */
  const isRuleValid = (r: LensRule): boolean => {
    const c = r.criteria;
    switch (c.type) {
      case 'ifcType': return !!c.ifcType;
      case 'attribute': return !!c.attributeName;
      case 'property': return !!c.propertySet && !!c.propertyName;
      case 'quantity': return !!c.quantitySet && !!c.quantityName;
      case 'classification': return !!c.classificationSystem || !!c.classificationCode;
      case 'material': return !!c.materialName;
      case 'model': return !!c.modelId;
      default: return false;
    }
  };

  const handleSave = () => {
    const validRules = rules.filter(isRuleValid);
    if (!name.trim() || validRules.length === 0) return;
    onSave({ ...initial, name: name.trim(), rules: validRules });
  };

  const canSave = name.trim().length > 0 && rules.some(isRuleValid);

  return (
    <div className="border-2 border-primary bg-white dark:bg-zinc-900 rounded-sm">
      {/* Name input */}
      <div className="px-3 pt-3 pb-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Lens name..."
          className="w-full px-2 py-1.5 text-xs font-bold uppercase tracking-wider bg-zinc-50 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm placeholder:normal-case placeholder:font-normal placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
          autoFocus
        />
      </div>

      {/* Rules */}
      <div className="border-t border-zinc-200 dark:border-zinc-700 py-1 bg-zinc-50/50 dark:bg-zinc-800/50">
        {rules.map((rule, i) => (
          <RuleEditor
            key={rule.id}
            rule={rule}
            onChange={(patch) => updateRule(i, patch)}
            onRemove={() => removeRule(i)}
            discovered={discovered}
            onRequestDiscovery={onRequestDiscovery}
          />
        ))}

        <button
          onClick={addRule}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary hover:text-primary/80 w-full"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Rule
        </button>
      </div>

      {/* Actions */}
      <div className="flex gap-1.5 p-2 border-t border-zinc-200 dark:border-zinc-700">
        <Button
          variant="default"
          size="sm"
          className="flex-1 h-7 text-[10px] uppercase tracking-wider rounded-sm"
          onClick={handleSave}
          disabled={!canSave}
        >
          <Save className="h-3 w-3 mr-1" />
          Save
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[10px] uppercase tracking-wider rounded-sm"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ─── Auto-color lens editor ─────────────────────────────────────────────────

function AutoColorEditor({
  initial,
  onSave,
  onCancel,
  discovered,
  onRequestDiscovery,
}: {
  initial: { name: string; autoColor: AutoColorSpec };
  onSave: (lens: Lens) => void;
  onCancel: () => void;
  discovered: DiscoveredLensData | null;
  onRequestDiscovery: (categories: { properties?: boolean; quantities?: boolean; classifications?: boolean; materials?: boolean }) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [source, setSource] = useState<AutoColorSpec['source']>(initial.autoColor.source);
  const [psetName, setPsetName] = useState(initial.autoColor.psetName ?? '');
  const [propertyName, setPropertyName] = useState(initial.autoColor.propertyName ?? '');

  const needsPset = source === 'property' || source === 'quantity' || source === 'classification';
  const needsPropertyName = source === 'attribute' || source === 'property' || source === 'quantity';

  // Trigger lazy discovery when source changes to a category that needs it
  useEffect(() => {
    if (!discovered) return;
    if (source === 'property' && !discovered.propertySets) {
      onRequestDiscovery({ properties: true });
    } else if (source === 'quantity' && !discovered.quantitySets) {
      onRequestDiscovery({ quantities: true });
    } else if (source === 'material' && !discovered.materials) {
      onRequestDiscovery({ materials: true });
    } else if (source === 'classification' && !discovered.classificationSystems) {
      onRequestDiscovery({ classifications: true });
    }
  }, [source, discovered, onRequestDiscovery]);

  // Dynamic options from discovered data
  const psetOptions = useMemo(() => {
    if (!discovered) return [];
    if (source === 'quantity') return discovered.quantitySets ? Array.from(discovered.quantitySets.keys()).sort() : [];
    if (source === 'classification') return discovered.classificationSystems ?? [];
    return discovered.propertySets ? Array.from(discovered.propertySets.keys()).sort() : [];
  }, [discovered, source]);

  const propertyOptions = useMemo(() => {
    if (!discovered) return [];
    if (source === 'property') return discovered.propertySets?.get(psetName) ?? [];
    if (source === 'quantity') return discovered.quantitySets?.get(psetName) ?? [];
    return [];
  }, [discovered, source, psetName]);

  const handleSave = () => {
    if (!name.trim()) return;
    if (needsPset && !psetName.trim()) return;
    if (needsPropertyName && !propertyName.trim()) return;

    const autoColor: AutoColorSpec = { source };
    if (needsPset) autoColor.psetName = psetName.trim();
    if (needsPropertyName) autoColor.propertyName = propertyName.trim();

    onSave({
      id: `lens-auto-${Date.now()}`,
      name: name.trim(),
      rules: [],
      autoColor,
    });
  };

  const canSave = name.trim().length > 0
    && (!needsPset || psetName.trim().length > 0)
    && (!needsPropertyName || propertyName.trim().length > 0);

  const selectClass = 'text-xs px-1.5 py-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm';

  return (
    <div className="border-2 border-primary bg-white dark:bg-zinc-900 rounded-sm">
      <div className="px-3 pt-3 pb-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Auto-color lens name..."
          className="w-full px-2 py-1.5 text-xs font-bold uppercase tracking-wider bg-zinc-50 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm placeholder:normal-case placeholder:font-normal placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
          autoFocus
        />
      </div>

      <div className="border-t border-zinc-200 dark:border-zinc-700 px-3 py-2 space-y-2 bg-zinc-50/50 dark:bg-zinc-800/50">
        <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          <Sparkles className="h-3 w-3" />
          <span>Auto-color by distinct values</span>
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-[10px] uppercase tracking-wider text-zinc-500 w-[50px]">Source</label>
          <select
            value={source}
            onChange={(e) => {
              const s = e.target.value as AutoColorSpec['source'];
              setSource(s);
              setPsetName('');
              setPropertyName('');
              if (!name || name.startsWith('Color by ')) {
                setName(`Color by ${TYPE_LABELS[s]}`);
              }
            }}
            className={cn(selectClass, 'flex-1')}
          >
            {AUTO_COLOR_SOURCES.map(s => (
              <option key={s} value={s}>{TYPE_LABELS[s]}</option>
            ))}
          </select>
        </div>

        {needsPset && (
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 w-[50px]">
              {source === 'property' ? 'Pset' : source === 'classification' ? 'System' : 'Qset'}
            </label>
            <SearchableSelect
              value={psetName}
              options={psetOptions}
              onChange={(v) => { setPsetName(v); setPropertyName(''); }}
              placeholder={source === 'property' ? 'Select property set...' : source === 'classification' ? 'Select system...' : 'Select quantity set...'}
              className="flex-1"
            />
          </div>
        )}

        {needsPropertyName && (
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 w-[50px]">Name</label>
            {source === 'attribute' ? (
              <select
                value={propertyName}
                onChange={(e) => setPropertyName(e.target.value)}
                className={cn(selectClass, 'flex-1')}
              >
                <option value="">Select...</option>
                {ENTITY_ATTRIBUTE_NAMES.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            ) : (
              <SearchableSelect
                value={propertyName}
                options={propertyOptions}
                onChange={setPropertyName}
                placeholder={source === 'property' ? 'Select property...' : 'Select quantity...'}
                className="flex-1"
              />
            )}
          </div>
        )}
      </div>

      <div className="flex gap-1.5 p-2 border-t border-zinc-200 dark:border-zinc-700">
        <Button
          variant="default"
          size="sm"
          className="flex-1 h-7 text-[10px] uppercase tracking-wider rounded-sm"
          onClick={handleSave}
          disabled={!canSave}
        >
          <Save className="h-3 w-3 mr-1" />
          Save
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[10px] uppercase tracking-wider rounded-sm"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ─── Lens card (read-only display) ──────────────────────────────────────────

function LensCard({
  lens,
  isActive,
  onToggle,
  onEdit,
  onDelete,
  isolatedRuleId,
  onIsolateRule,
  ruleCounts,
  autoColorLegend,
}: {
  lens: Lens;
  isActive: boolean;
  onToggle: (id: string) => void;
  onEdit?: (lens: Lens) => void;
  onDelete?: (id: string) => void;
  isolatedRuleId?: string | null;
  onIsolateRule?: (ruleId: string) => void;
  ruleCounts?: Map<string, number>;
  autoColorLegend?: AutoColorLegendEntry[];
}) {
  const isAutoColor = !!lens.autoColor;
  const enabledRuleCount = lens.rules.filter(r => r.enabled).length;
  const [legendSort, setLegendSort] = useState<'count' | 'name-asc' | 'name-desc'>('count');

  const legendToShow = useMemo(() => {
    if (!isAutoColor || !autoColorLegend) return undefined;
    if (legendSort === 'count') return autoColorLegend; // already sorted by count desc from engine
    const sorted = [...autoColorLegend];
    if (legendSort === 'name-asc') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else sorted.sort((a, b) => b.name.localeCompare(a.name));
    return sorted;
  }, [isAutoColor, autoColorLegend, legendSort]);

  const cycleLegendSort = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setLegendSort(prev => prev === 'count' ? 'name-asc' : prev === 'name-asc' ? 'name-desc' : 'count');
  }, []);

  const sortLabel = legendSort === 'count' ? 'Count' : legendSort === 'name-asc' ? 'A→Z' : 'Z→A';

  return (
    <div
      className={cn(
        'border-2 transition-colors cursor-pointer group rounded-sm',
        isActive
          ? 'border-primary bg-white dark:bg-zinc-900'
          : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:border-zinc-400 dark:hover:border-zinc-500',
      )}
      onClick={() => onToggle(lens.id)}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {isActive ? (
            <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />
          ) : isAutoColor ? (
            <Sparkles className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500 flex-shrink-0" />
          ) : (
            <Palette className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500 flex-shrink-0" />
          )}
          <span className="text-xs font-bold uppercase tracking-wider text-zinc-900 dark:text-zinc-100 truncate">
            {lens.name}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onEdit && !isAutoColor && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(lens); }}
              className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 p-0.5"
              title="Edit lens"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          {!lens.builtin && onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(lens.id); }}
              className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400 p-0.5"
              title="Delete lens"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-mono ml-1">
            {isAutoColor
              ? TYPE_LABELS[lens.autoColor!.source]
              : `${enabledRuleCount} rules`}
          </span>
        </div>
      </div>

      {/* Auto-color legend (shown when active + auto-color lens) */}
      {isActive && legendToShow && legendToShow.length > 0 && (
        <div className="border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
          <div className="flex items-center justify-between px-3 py-1 border-b border-zinc-200/60 dark:border-zinc-700/60">
            <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-medium">
              {legendToShow.length} values
            </span>
            <button
              onClick={cycleLegendSort}
              className="flex items-center gap-0.5 text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300"
              title="Sort legend entries"
            >
              <ArrowUpDown className="h-2.5 w-2.5" />
              {sortLabel}
            </button>
          </div>
          <div className="max-h-[220px] overflow-y-auto py-0.5">
          {legendToShow.map(entry => (
            <AutoColorRow
              key={entry.id}
              entry={entry}
              isIsolated={isolatedRuleId === entry.id}
              onClick={onIsolateRule ? () => onIsolateRule(entry.id) : undefined}
            />
          ))}
          </div>
        </div>
      )}

      {/* Rule-based color legend (shown when active + rule lens) */}
      {isActive && !isAutoColor && (
        <div className="border-t border-zinc-200 dark:border-zinc-700 py-0.5 bg-zinc-50 dark:bg-zinc-800/60">
          {lens.rules.map(rule => {
            const count = ruleCounts?.get(rule.id) ?? 0;
            return (
              <RuleRow
                key={rule.id}
                rule={rule}
                count={count}
                isIsolated={isolatedRuleId === rule.id}
                onClick={onIsolateRule ? () => onIsolateRule(rule.id) : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main panel ─────────────────────────────────────────────────────────────

export function LensPanel({ onClose }: LensPanelProps) {
  const { activeLensId, savedLenses } = useLens();
  const setActiveLens = useViewerStore((s) => s.setActiveLens);
  const createLens = useViewerStore((s) => s.createLens);
  const updateLens = useViewerStore((s) => s.updateLens);
  const deleteLens = useViewerStore((s) => s.deleteLens);
  const importLenses = useViewerStore((s) => s.importLenses);
  const exportLenses = useViewerStore((s) => s.exportLenses);
  const hideEntities = useViewerStore((s) => s.hideEntities);
  const showAll = useViewerStore((s) => s.showAll);
  const isolateEntities = useViewerStore((s) => s.isolateEntities);
  const clearIsolation = useViewerStore((s) => s.clearIsolation);
  // For footer stats — cheap primitive subscriptions
  const lensColorMapSize = useViewerStore((s) => s.lensColorMap.size);
  const lensHiddenIdsSize = useViewerStore((s) => s.lensHiddenIds.size);
  const lensRuleCounts = useViewerStore((s) => s.lensRuleCounts);
  const lensAutoColorLegend = useViewerStore((s) => s.lensAutoColorLegend);
  // Discovered data from loaded models (classes = instant, rest = lazy)
  const discoveredLensData = useViewerStore((s) => s.discoveredLensData);
  const mergeDiscoveredData = useViewerStore((s) => s.mergeDiscoveredData);

  // Track which categories are currently being discovered (prevent double-fire)
  const discoveringRef = useRef(new Set<string>());

  // Reset discovery flags when discoveredLensData changes (e.g. new model loaded)
  useEffect(() => {
    if (!discoveredLensData) {
      discoveringRef.current.clear();
    }
  }, [discoveredLensData]);

  /** Trigger lazy discovery for expensive data categories (psets, quantities, etc.) */
  const handleRequestDiscovery = useCallback((categories: { properties?: boolean; quantities?: boolean; classifications?: boolean; materials?: boolean }) => {
    // Skip categories already discovered or in-flight
    const toDiscover: typeof categories = {};
    const current = useViewerStore.getState().discoveredLensData;
    if (!current) return;

    if (categories.properties && !current.propertySets && !discoveringRef.current.has('properties')) {
      toDiscover.properties = true;
      discoveringRef.current.add('properties');
    }
    if (categories.quantities && !current.quantitySets && !discoveringRef.current.has('quantities')) {
      toDiscover.quantities = true;
      discoveringRef.current.add('quantities');
    }
    if (categories.classifications && !current.classificationSystems && !discoveringRef.current.has('classifications')) {
      toDiscover.classifications = true;
      discoveringRef.current.add('classifications');
    }
    if (categories.materials && !current.materials && !discoveringRef.current.has('materials')) {
      toDiscover.materials = true;
      discoveringRef.current.add('materials');
    }

    if (Object.keys(toDiscover).length === 0) return;

    // Run discovery async to not block the UI
    setTimeout(() => {
      const { models, ifcDataStore } = useViewerStore.getState();
      if (models.size === 0 && !ifcDataStore) return;
      const provider = createLensDataProvider(models, ifcDataStore);
      const result = discoverDataSources(provider, toDiscover);
      mergeDiscoveredData(result);
    }, 0);
  }, [mergeDiscoveredData]);

  // Editor state: null = not editing, Lens object = editing/creating
  const [editingLens, setEditingLens] = useState<Lens | null>(null);
  const [creatingAutoColor, setCreatingAutoColor] = useState(false);
  const [isolatedRuleId, setIsolatedRuleId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleToggle = useCallback((id: string) => {
    setIsolatedRuleId(null);
    if (activeLensId === id) {
      setActiveLens(null);
      showAll();
    } else {
      setActiveLens(id);
    }
  }, [activeLensId, setActiveLens, showAll]);

  /** Click a rule/value row in the active lens to isolate matching entities */
  const handleIsolateRule = useCallback((ruleId: string) => {
    // Toggle off if clicking the already-isolated rule
    if (isolatedRuleId === ruleId) {
      setIsolatedRuleId(null);
      clearIsolation();
      return;
    }

    // Look up entities matched by this specific rule/value
    const matchingIds = useViewerStore.getState().lensRuleEntityIds.get(ruleId);
    if (!matchingIds || matchingIds.length === 0) return;

    setIsolatedRuleId(ruleId);
    isolateEntities(matchingIds);
  }, [isolatedRuleId, isolateEntities, clearIsolation]);

  const handleNewLens = useCallback(() => {
    setCreatingAutoColor(false);
    setEditingLens({
      id: `lens-${Date.now()}`,
      name: '',
      rules: [],
    });
  }, []);

  const handleNewAutoColorLens = useCallback(() => {
    setEditingLens(null);
    setCreatingAutoColor(true);
  }, []);

  const handleEditLens = useCallback((lens: Lens) => {
    setEditingLens({ ...lens, rules: lens.rules.map(r => ({ ...r })) });
  }, []);

  const handleSaveLens = useCallback((lens: Lens) => {
    const exists = savedLenses.some(l => l.id === lens.id);
    if (exists) {
      updateLens(lens.id, { name: lens.name, rules: lens.rules, autoColor: lens.autoColor });
    } else {
      createLens(lens);
    }
    setEditingLens(null);
    setCreatingAutoColor(false);
  }, [savedLenses, createLens, updateLens]);

  const handleDeleteLens = useCallback((id: string) => {
    if (activeLensId === id) {
      setActiveLens(null);
      showAll();
    }
    deleteLens(id);
  }, [activeLensId, setActiveLens, showAll, deleteLens]);

  // Apply hidden entities when lens hidden IDs change
  useEffect(() => {
    if (lensHiddenIdsSize > 0 && activeLensId) {
      const ids = useViewerStore.getState().lensHiddenIds;
      hideEntities(Array.from(ids));
    }
  }, [activeLensId, lensHiddenIdsSize, hideEntities]);

  const handleExport = useCallback(() => {
    const data = exportLenses();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lenses.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [exportLenses]);

  const handleImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        const valid = arr.filter((item): item is Lens => {
          if (item === null || typeof item !== 'object') return false;
          const obj = item as Record<string, unknown>;
          return typeof obj.id === 'string' && obj.id.length > 0
            && typeof obj.name === 'string' && obj.name.length > 0
            && Array.isArray(obj.rules);
        });
        if (valid.length > 0) {
          importLenses(valid);
        }
      } catch {
        // invalid JSON — silently ignore
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [importLenses]);

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-primary" />
          <h2 className="font-bold uppercase tracking-wider text-xs text-zinc-900 dark:text-zinc-100">
            Lens
          </h2>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 rounded-sm"
            onClick={handleExport}
            title="Export lenses as JSON"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 rounded-sm"
            onClick={() => fileInputRef.current?.click()}
            title="Import lenses from JSON"
          >
            <Upload className="h-3.5 w-3.5" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImport}
          />
          {activeLensId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[10px] uppercase tracking-wider rounded-sm"
              onClick={() => { setActiveLens(null); showAll(); }}
            >
              <EyeOff className="h-3 w-3 mr-1" />
              Clear
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 rounded-sm"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Lens list + editor */}
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {savedLenses.map(lens => (
          editingLens?.id === lens.id ? (
            <LensEditor
              key={lens.id}
              initial={editingLens}
              onSave={handleSaveLens}
              onCancel={() => setEditingLens(null)}
              discovered={discoveredLensData}
              onRequestDiscovery={handleRequestDiscovery}
            />
          ) : (
            <LensCard
              key={lens.id}
              lens={lens}
              isActive={activeLensId === lens.id}
              onToggle={handleToggle}
              onEdit={handleEditLens}
              onDelete={handleDeleteLens}
              isolatedRuleId={activeLensId === lens.id ? isolatedRuleId : null}
              onIsolateRule={activeLensId === lens.id ? handleIsolateRule : undefined}
              ruleCounts={activeLensId === lens.id ? lensRuleCounts : undefined}
              autoColorLegend={activeLensId === lens.id ? lensAutoColorLegend : undefined}
            />
          )
        ))}

        {/* New lens editor (when creating rule-based lens) */}
        {editingLens && !savedLenses.some(l => l.id === editingLens.id) && (
          <LensEditor
            initial={editingLens}
            onSave={handleSaveLens}
            onCancel={() => setEditingLens(null)}
            discovered={discoveredLensData}
            onRequestDiscovery={handleRequestDiscovery}
          />
        )}

        {/* Auto-color editor (when creating auto-color lens) */}
        {creatingAutoColor && (
          <AutoColorEditor
            initial={{ name: 'Color by IFC Class', autoColor: { source: 'ifcType' } }}
            onSave={handleSaveLens}
            onCancel={() => setCreatingAutoColor(false)}
            discovered={discoveredLensData}
            onRequestDiscovery={handleRequestDiscovery}
          />
        )}

        {/* New lens buttons */}
        {!editingLens && !creatingAutoColor && (
          <div className="space-y-1.5">
            <button
              onClick={handleNewLens}
              className="w-full border-2 border-dashed border-zinc-300 dark:border-zinc-600 hover:border-primary dark:hover:border-primary py-2.5 flex items-center justify-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-primary transition-colors rounded-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              New Rule Lens
            </button>
            <button
              onClick={handleNewAutoColorLens}
              className="w-full border-2 border-dashed border-zinc-300 dark:border-zinc-600 hover:border-primary dark:hover:border-primary py-2.5 flex items-center justify-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-primary transition-colors rounded-sm"
            >
              <Sparkles className="h-3.5 w-3.5" />
              New Auto-Color Lens
            </button>
          </div>
        )}
      </div>

      {/* Status footer */}
      <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-600 dark:text-zinc-400 text-center bg-zinc-50 dark:bg-zinc-900 font-mono">
        {activeLensId
          ? `Active · ${lensColorMapSize} colored · ${lensHiddenIdsSize > 0 ? `${lensHiddenIdsSize} hidden` : 'ghosted'}`
          : 'Click a lens to activate'}
      </div>
    </div>
  );
}
