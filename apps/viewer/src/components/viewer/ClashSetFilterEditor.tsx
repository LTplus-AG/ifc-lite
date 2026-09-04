/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One side (A or B) of a clash rule, defined as an advanced filter (#3902).
 *
 * Deliberately the SAME rows the search modal's filter builder shows — same
 * `RuleRow`, same AND/OR toggle, same "Add rule" menu, same rule kinds — so a
 * coordinator who can express "external walls above +3.00 m" in the search
 * panel can express it as a clash set without learning a second dialect.
 *
 * An empty rule list is stored as no filter at all, which is what lets the
 * side fall back to its type selector (see `lib/clash/set-filter.ts`).
 */

import { useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFilterRuleOptions } from '@/hooks/useFilterRuleOptions';
import type { FilterRule } from '@/lib/search/filter-rules';
import type { ClashSetFilter } from '@/lib/clash/set-filter';
import { AddRuleMenu, CombinatorToggle, blankRuleOfKind } from './FilterRuleControls';
import { RuleRow } from './SearchModal.filter.editors';

const NO_RULES: FilterRule[] = [];

export interface ClashSetFilterEditorProps {
  /** "Set A" / "Set B" — which side of the rule this defines. */
  label: string;
  filter: ClashSetFilter | undefined;
  onChange: (next: ClashSetFilter | undefined) => void;
}

export function ClashSetFilterEditor({ label, filter, onChange }: ClashSetFilterEditorProps) {
  const rules = filter?.rules ?? NO_RULES;
  const combinator = filter?.combinator ?? 'AND';
  const ruleOptions = useFilterRuleOptions(rules);

  const commit = useCallback(
    (nextRules: FilterRule[], nextCombinator = combinator) => {
      // No rules is no filter — never an empty filter, which the resolver
      // would (correctly) read as "this side matches nothing".
      onChange(nextRules.length === 0 ? undefined : { combinator: nextCombinator, rules: nextRules });
    },
    [combinator, onChange],
  );

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {rules.length > 1 && (
          <CombinatorToggle value={combinator} onChange={(c) => commit(rules.slice(), c)} />
        )}
        <AddRuleMenu onAdd={(kind) => commit([...rules, blankRuleOfKind(kind)])} label="Add filter rule" />
        {rules.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-[11px] text-muted-foreground"
            onClick={() => commit([])}
            title="Remove every rule and go back to the type selector"
          >
            <Trash2 className="h-3 w-3" /> Clear
          </Button>
        )}
      </div>

      {rules.map((rule, i) => (
        <RuleRow
          key={i}
          rule={rule}
          {...ruleOptions}
          onChange={(next) => commit(rules.map((r, j) => (j === i ? next : r)))}
          onRemove={() => commit(rules.filter((_, j) => j !== i))}
        />
      ))}

      {rules.length > 0 && (
        <p className="text-[10px] text-muted-foreground leading-snug">
          This filter defines {label.toLowerCase()}; its type selector above is ignored while it has rules.
        </p>
      )}
    </div>
  );
}
