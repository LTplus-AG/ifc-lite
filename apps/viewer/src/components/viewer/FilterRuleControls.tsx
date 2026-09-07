/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two controls that frame any list of `FilterRule` rows: the AND/OR
 * combinator toggle and the "Add rule" menu.
 *
 * Both used to be private to `SearchModal.filter.builder.tsx`. The clash
 * panel's per-side set filter (#3902) is the same rule list with the same
 * combinator, so they live here rather than being copied — a second AND/OR
 * toggle that offered a different set of rule kinds would be the drift this
 * whole feature exists to avoid.
 */

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { Rule, type Combinator, type FilterRule } from '@/lib/search/filter-rules';
import { RULE_KIND_LABEL } from './filter-rule-labels';

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

export function AddRuleMenu({
  onAdd,
  label = 'Add rule',
}: {
  onAdd: (kind: FilterRule['kind']) => void;
  label?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 self-start text-xs">
          <Plus className="h-3 w-3" />
          {label}
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

/**
 * A blank rule of the given kind. One definition of "what a new Property row
 * starts as", shared by every builder, so a kind added to `RULE_KIND_LABEL`
 * cannot appear in the menu of one builder and be unconstructible in another.
 */
export function blankRuleOfKind(kind: FilterRule['kind']): FilterRule {
  switch (kind) {
    case 'model':          return Rule.model([], 'in');
    case 'storey':         return Rule.storey([], 'in');
    case 'ifcType':        return Rule.ifcType([], 'in');
    case 'predefinedType': return Rule.predefinedType([], 'in');
    case 'name':           return Rule.name('contains', '');
    case 'property':       return Rule.property('', '', 'eq', '');
    case 'quantity':       return Rule.quantity('', '', 'gt', 0);
    case 'material':       return Rule.material('contains', '');
    case 'classification': return Rule.classification('', 'contains', '');
    case 'elevation':      return Rule.elevation('gt', 0);
  }
}
