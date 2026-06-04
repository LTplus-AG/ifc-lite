/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-rule chip editors for the filter builder. Split out of
 * `SearchModal.filter.builder.tsx` (which keeps the toolbar / preset /
 * run-state orchestration) to stay under the module size cap. `RuleRow`
 * dispatches to the right per-kind editor; the builder only imports
 * `RuleRow` and `RULE_KIND_LABEL`.
 */

import { useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  Rule,
  type FilterRule,
  type SetOp,
  type StringOp,
  type ValueOp,
  type NumericOp,
  type ClassificationOp,
} from '@/lib/search/filter-rules';
import { ComboInput } from '@/components/ui/combo-input';
import { propValueKey, type FilterValueSchema } from '@/lib/search/filter-schema';

const NO_OPTIONS: readonly string[] = [];

// ── Op constants ──────────────────────────────────────────────────────

const SET_OPS: SetOp[] = ['in', 'notIn'];
const STRING_OPS: StringOp[] = ['eq', 'ne', 'contains', 'notContains', 'startsWith'];
const VALUE_OPS: ValueOp[] = [
  'eq', 'ne', 'contains', 'notContains', 'gt', 'gte', 'lt', 'lte', 'isSet', 'isNotSet',
];
const NUMERIC_OPS: NumericOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
const CLASSIFICATION_OPS: ClassificationOp[] = [
  'contains', 'eq', 'ne', 'notContains', 'isSet', 'isNotSet',
];

const OP_LABEL: Record<string, string> = {
  in: 'is one of',  notIn: 'is not one of',
  eq: '=', ne: '≠',
  contains: 'contains', notContains: 'does not contain',
  startsWith: 'starts with',
  gt: '>', gte: '≥', lt: '<', lte: '≤',
  isSet: 'is set', isNotSet: 'is not set',
};

export const RULE_KIND_LABEL: Record<FilterRule['kind'], string> = {
  storey:          'Storey',
  ifcType:         'IFC Type',
  predefinedType:  'Predefined Type',
  name:            'Name',
  property:        'Property',
  quantity:        'Quantity',
  material:        'Material',
  classification:  'Classification',
  elevation:       'Elevation',
};

// ── Rule row dispatcher ───────────────────────────────────────────────

export interface RuleRowProps {
  rule: FilterRule;
  ifcTypeOptions: string[];
  storeyOptions: ReadonlyArray<readonly [string, number | null]>;
  psetQto: { psets: ReadonlyArray<readonly [string, ReadonlyArray<string>]>; qtos: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> } | null;
  /** Distinct model values for value suggestions (materials, classifications, property values). */
  valueSchema: FilterValueSchema | null;
  onChange: (next: FilterRule) => void;
  onRemove: () => void;
}

export function RuleRow({ rule, ifcTypeOptions, storeyOptions, psetQto, valueSchema, onChange, onRemove }: RuleRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded border border-zinc-200 bg-white px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-950">
      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
        {RULE_KIND_LABEL[rule.kind]}
      </span>

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
        <PropertyEditor rule={rule} psetQto={psetQto} valueSchema={valueSchema} onChange={onChange} />
      )}

      {rule.kind === 'quantity' && (
        <QuantityEditor rule={rule} psetQto={psetQto} onChange={onChange} />
      )}

      {rule.kind === 'material' && (
        <MaterialEditor
          op={rule.op}
          value={rule.value}
          options={valueSchema?.materials ?? NO_OPTIONS}
          onChange={(op, value) => onChange(Rule.material(op, value))}
        />
      )}

      {rule.kind === 'classification' && (
        <ClassificationEditor rule={rule} valueSchema={valueSchema} onChange={onChange} />
      )}

      {rule.kind === 'elevation' && (
        <ElevationEditor
          op={rule.op}
          value={rule.value}
          onChange={(op, value) => onChange(Rule.elevation(op, value))}
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
              No options available — load a model first.
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
  valueSchema: FilterValueSchema | null;
  onChange: (next: FilterRule) => void;
}

function PropertyEditor({ rule, psetQto, valueSchema, onChange }: PropertyEditorProps) {
  const psetNames = useMemo(() => (psetQto ? psetQto.psets.map(([n]) => n) : []), [psetQto]);
  const propNames = useMemo(() => {
    if (!psetQto) return [];
    const entry = psetQto.psets.find(([n]) => n === rule.setName);
    return entry ? Array.from(entry[1]) : [];
  }, [psetQto, rule.setName]);
  const valueOptions = useMemo(
    () => valueSchema?.propertyValues.get(propValueKey(rule.setName, rule.propertyName)) ?? NO_OPTIONS,
    [valueSchema, rule.setName, rule.propertyName],
  );

  const valueless = rule.op === 'isSet' || rule.op === 'isNotSet';

  return (
    <>
      <ComboInput
        placeholder="Pset_… (e.g. Pset_WallCommon)"
        value={rule.setName}
        options={psetNames}
        className="h-7 w-52 text-xs font-mono"
        onChange={(next) => onChange({ ...rule, setName: next, propertyName: '' })}
      />
      <span className="text-muted-foreground">.</span>
      <ComboInput
        placeholder="prop name"
        value={rule.propertyName}
        options={propNames}
        className="h-7 w-44 text-xs font-mono"
        onChange={(next) => onChange({ ...rule, propertyName: next })}
      />
      <OpDropdown ops={VALUE_OPS} value={rule.op} onChange={(next) => onChange({ ...rule, op: next })} />
      {!valueless && (
        <ComboInput
          placeholder="value"
          value={rule.value}
          options={valueOptions}
          className="h-7 w-44 text-xs font-mono"
          onChange={(value) => onChange({ ...rule, value })}
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
      <ComboInput
        placeholder="Qto_… (e.g. Qto_WallBaseQuantities)"
        value={rule.setName}
        options={qsetNames}
        className="h-7 w-56 text-xs font-mono"
        onChange={(next) => onChange({ ...rule, setName: next, quantityName: '' })}
      />
      <span className="text-muted-foreground">.</span>
      <ComboInput
        placeholder="quantity name"
        value={rule.quantityName}
        options={qtyNames}
        className="h-7 w-44 text-xs font-mono"
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

function MaterialEditor({
  op,
  value,
  options,
  onChange,
}: {
  op: StringOp;
  value: string;
  options: ReadonlyArray<string>;
  onChange: (op: StringOp, value: string) => void;
}) {
  return (
    <>
      <OpDropdown ops={STRING_OPS} value={op} onChange={(next) => onChange(next, value)} />
      <ComboInput
        placeholder="material name (e.g. Concrete)"
        value={value}
        options={options}
        className="h-7 w-56 text-xs font-mono"
        onChange={(v) => onChange(op, v)}
      />
    </>
  );
}

function ClassificationEditor({
  rule,
  valueSchema,
  onChange,
}: {
  rule: Extract<FilterRule, { kind: 'classification' }>;
  valueSchema: FilterValueSchema | null;
  onChange: (next: FilterRule) => void;
}) {
  const valueless = rule.op === 'isSet' || rule.op === 'isNotSet';
  return (
    <>
      <ComboInput
        placeholder="system (optional)"
        value={rule.system ?? ''}
        options={valueSchema?.classificationSystems ?? NO_OPTIONS}
        className="h-7 w-40 text-xs font-mono"
        aria-label="Classification system — leave blank for any"
        onChange={(v) => onChange(Rule.classification(v, rule.op, rule.value))}
      />
      <OpDropdown
        ops={CLASSIFICATION_OPS}
        value={rule.op}
        onChange={(next) => onChange(Rule.classification(rule.system ?? '', next, rule.value))}
      />
      {!valueless && (
        <ComboInput
          placeholder="code or name"
          value={rule.value}
          options={valueSchema?.classifications ?? NO_OPTIONS}
          className="h-7 w-44 text-xs font-mono"
          onChange={(v) => onChange(Rule.classification(rule.system ?? '', rule.op, v))}
        />
      )}
    </>
  );
}

function ElevationEditor({
  op,
  value,
  onChange,
}: {
  op: NumericOp;
  value: number;
  onChange: (op: NumericOp, value: number) => void;
}) {
  return (
    <>
      <OpDropdown ops={NUMERIC_OPS} value={op} onChange={(next) => onChange(next, value)} />
      <Input
        type="number"
        step="any"
        placeholder="metres"
        value={value}
        onChange={(e) => onChange(op, Number.parseFloat(e.target.value) || 0)}
        className="h-7 w-28 text-xs font-mono"
      />
      <span className="text-[10px] text-muted-foreground">m (storey elevation)</span>
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

