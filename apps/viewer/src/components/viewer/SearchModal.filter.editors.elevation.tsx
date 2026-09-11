/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The `elevation` chip editor, split out of `SearchModal.filter.editors.tsx` for size. */

import { Input } from '@/components/ui/input';
import type { NumericOp } from '@/lib/search/filter-rules';
import { NUMERIC_OPS, OpDropdown } from './SearchModal.filter.editors.shared';

export function ElevationEditor({
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

