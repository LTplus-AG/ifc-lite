/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generic widgets reused across the Filter modal — no rule semantics
 * here, just input controls. Lives in its own module so the per-kind
 * editors and the toolbar can both compose them without circular
 * imports.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

/** Op label table — friendlier text in dropdowns; the canonical token
 *  is shown in muted text so the SQL-readable value stays visible. */
export const OP_LABEL: Record<string, string> = {
  in: 'is one of',  notIn: 'is not one of',
  eq: '=', ne: '≠',
  contains: 'contains', notContains: 'does not contain',
  startsWith: 'starts with',
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

/**
 * Free-text input that exposes a small dropdown of known options when
 * the schema knows them. Users can either pick from the menu or type
 * a value not present in the schema (useful for typos / custom psets).
 */
export function FreeOrPickInput({
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

/**
 * Numeric `<input>` that lets the user clear the field while editing.
 *
 * The naïve pattern `value={n}` with `onChange={…parseInt(v) || 0}`
 * snaps the input to "0" the moment the user deletes the digits, so
 * replacing "500" with "50" requires going through 0 first. This
 * variant holds an in-flight string buffer locally; the parent only
 * sees a parsed number when the input is valid. On blur (or when the
 * external value changes), the buffer resyncs.
 */
export function NumericInput({
  value,
  min,
  step,
  parse,
  onCommit,
  className,
  placeholder,
}: {
  value: number;
  min?: number;
  step?: number;
  parse: (raw: string) => number | null;
  onCommit: (next: number) => void;
  className?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState<string>(String(value));
  // Keep the buffer aligned with external state changes (preset load,
  // reset, etc.) while not stomping on a partially-typed value.
  useEffect(() => {
    setText(String(value));
  }, [value]);
  return (
    <Input
      type="number"
      min={min}
      step={step}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const parsed = parse(raw);
        if (parsed !== null) onCommit(parsed);
      }}
      onBlur={() => {
        // Empty / invalid on blur → snap back to the last committed
        // value so the input doesn't render as blank indefinitely.
        if (parse(text) === null) setText(String(value));
      }}
      className={className}
    />
  );
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
