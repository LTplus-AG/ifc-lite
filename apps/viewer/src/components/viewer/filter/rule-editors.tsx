/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-kind chip editors for FilterRule. One small component per
 * discriminant + a `RuleRow` that picks the right editor by kind.
 */

import { useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import {
  Rule,
  type FilterRule,
  type SetOp,
  type StringOp,
  type ValueOp,
  type NumericOp,
} from '@/lib/search/filter-rules';
import { OpDropdown, FreeOrPickInput, NumericInput } from './widgets';

const SET_OPS: SetOp[] = ['in', 'notIn'];
const STRING_OPS: StringOp[] = ['eq', 'ne', 'contains', 'notContains', 'startsWith'];
const VALUE_OPS: ValueOp[] = [
  'eq', 'ne', 'contains', 'notContains', 'gt', 'gte', 'lt', 'lte', 'isSet', 'isNotSet',
];
const NUMERIC_OPS: NumericOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];

export const RULE_KIND_LABEL: Record<FilterRule['kind'], string> = {
  storey:          'Storey',
  ifcType:         'IFC Type',
  predefinedType:  'Predefined Type',
  name:            'Name',
  property:        'Property',
  quantity:        'Quantity',
};

export type PsetQtoSchemaShape = {
  psets: ReadonlyArray<readonly [string, ReadonlyArray<string>]>;
  qtos: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]>;
};

export interface RuleRowProps {
  rule: FilterRule;
  ifcTypeOptions: string[];
  storeyOptions: ReadonlyArray<readonly [string, number | null]>;
  psetQto: PsetQtoSchemaShape | null;
  onChange: (next: FilterRule) => void;
  onRemove: () => void;
}

export function RuleRow({ rule, ifcTypeOptions, storeyOptions, psetQto, onChange, onRemove }: RuleRowProps) {
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
        <PropertyEditor rule={rule} psetQto={psetQto} onChange={onChange} />
      )}

      {rule.kind === 'quantity' && (
        <QuantityEditor rule={rule} psetQto={psetQto} onChange={onChange} />
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
  psetQto: PsetQtoSchemaShape | null;
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
  psetQto: PsetQtoSchemaShape | null;
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
      <NumericInput
        value={rule.value}
        placeholder="value"
        // Empty buffer while editing → don't commit. Partial decimals
        // ("0.") stay in the buffer; we only commit on valid parse.
        parse={(raw) => {
          if (raw === '') return null;
          const n = Number.parseFloat(raw);
          return Number.isFinite(n) ? n : null;
        }}
        onCommit={(next) => onChange({ ...rule, value: next })}
        className="h-7 w-32 text-xs font-mono"
      />
    </>
  );
}
