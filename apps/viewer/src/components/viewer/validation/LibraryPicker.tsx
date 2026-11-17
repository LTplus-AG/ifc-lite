/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { HTMLAttributes, ReactNode } from 'react';

/** The validation libraries' picker toolbar (IDS documents, rule sets,
 * manual checklists): a labelled select on its own full-width row, the
 * library actions in a wrapping row below it (#8802). When the label shared
 * the actions' wrapping row, four or five buttons squeezed it to a clipped
 * stub ("Select IDS documer") and the select to a sliver at side-panel widths. */
export function LibraryPicker({ label, value, onSelect, options, actions, children, ...rest }: {
  label: string;
  value: string;
  onSelect: (id: string) => void;
  /** The select's `<option>` elements. */
  options: ReactNode;
  /** The library actions, laid out in a wrapping row under the picker. */
  actions: ReactNode;
  /** Anything below the actions, such as an error. */
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onSelect'>) {
  return <div {...rest} className="flex flex-col gap-2 border-b p-2">
    <label className="flex flex-col gap-1 text-xs">
      {label}
      <select aria-label={label} className="h-7 w-full min-w-0 rounded border border-input bg-background px-1.5"
        value={value} onChange={event => onSelect(event.target.value)}>
        {options}
      </select>
    </label>
    <div className="flex flex-wrap items-center gap-2">{actions}</div>
    {children}
  </div>;
}
