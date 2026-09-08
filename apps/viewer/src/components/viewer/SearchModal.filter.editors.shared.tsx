/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Op constants and the `OpDropdown` widget shared by every per-rule chip
 * editor. Split out of `SearchModal.filter.editors.tsx` so both it and
 * `SearchModal.filter.editors.identity.tsx` (the `globalId`/`attribute`
 * editors, #4094) can depend on this without importing each other.
 */

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import type { SetOp, StringOp, ValueOp, NumericOp, ClassificationOp } from '@/lib/search/filter-rules';

export const SET_OPS: SetOp[] = ['in', 'notIn'];
export const STRING_OPS: StringOp[] = ['eq', 'ne', 'contains', 'notContains', 'startsWith', 'matches', 'notMatches'];
export const VALUE_OPS: ValueOp[] = [
  'eq', 'ne', 'contains', 'notContains', 'matches', 'notMatches', 'gt', 'gte', 'lt', 'lte', 'isSet', 'isNotSet',
];
export const NUMERIC_OPS: NumericOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
export const CLASSIFICATION_OPS: ClassificationOp[] = [
  'contains', 'eq', 'ne', 'notContains', 'matches', 'notMatches', 'isSet', 'isNotSet',
];

export const OP_LABEL: Record<string, string> = {
  in: 'is one of',  notIn: 'is not one of',
  eq: '=', ne: '≠',
  contains: 'contains', notContains: 'does not contain',
  startsWith: 'starts with', matches: 'matches /regex/', notMatches: 'does not match /regex/',
  gt: '>', gte: '≥', lt: '<', lte: '≤',
  isSet: 'is set', isNotSet: 'is not set',
};

export function OpDropdown<T extends string>({
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
