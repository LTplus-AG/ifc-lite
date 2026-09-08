/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `globalId` and `attribute` rule chip editors (#4094). Split out of
 * `SearchModal.filter.editors.tsx` (which keeps every other per-kind editor
 * and `RuleRow`) to stay under the module size cap — these two are the
 * newest rule kinds and have no dependency on the pset/qto/valueSchema
 * plumbing the rest of that file threads through.
 */

import { Input } from '@/components/ui/input';
import type { FilterRule, SetOp } from '@/lib/search/filter-rules';
import { OpDropdown, SET_OPS, VALUE_OPS } from './SearchModal.filter.editors.shared';

/** Free-typed GlobalIds, comma-separated — there's no bounded options list to
 *  pick from (a GlobalId dropdown of every element in a huge model isn't
 *  useful UI), so this is the `PredefinedTypeEditor` text-input half without
 *  the "Pick" dropdown. */
export function GlobalIdEditor({
  values,
  op,
  onChange,
}: {
  values: string[];
  op: SetOp;
  onChange: (values: string[], op: SetOp) => void;
}) {
  const text = values.join(', ');
  const setFromText = (raw: string) =>
    onChange(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0), op);
  return (
    <>
      <OpDropdown ops={SET_OPS} value={op} onChange={(next) => onChange(values, next)} />
      <Input
        placeholder="e.g. 325Q7Fhnf67OZC$$r43uzK"
        value={text}
        onChange={(e) => setFromText(e.target.value)}
        className="h-7 w-64 text-xs font-mono"
      />
    </>
  );
}

export function AttributeEditor({
  rule,
  onChange,
}: {
  rule: Extract<FilterRule, { kind: 'attribute' }>;
  onChange: (next: FilterRule) => void;
}) {
  const valueless = rule.op === 'isSet' || rule.op === 'isNotSet';
  return (
    <>
      <Input
        placeholder="Description, ObjectType, Tag, …"
        value={rule.name}
        onChange={(e) => onChange({ ...rule, name: e.target.value })}
        className="h-7 w-40 text-xs font-mono"
      />
      <OpDropdown ops={VALUE_OPS} value={rule.op} onChange={(next) => onChange({ ...rule, op: next })} />
      {!valueless && (
        <Input
          placeholder="value"
          value={rule.value}
          onChange={(e) => onChange({ ...rule, value: e.target.value, valueKind: undefined })}
          className="h-7 w-44 text-xs font-mono"
        />
      )}
    </>
  );
}
