/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A titled group of controls inside a Settings section, and one labelled
 *  row in it. Shared so every section reads the same. */

import type { ReactNode } from 'react';

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="space-y-3 rounded-md border p-3">{children}</div>
    </section>
  );
}

export function SettingsRow({ label, hint, htmlFor, children }: {
  label: string;
  hint?: string;
  /** The control's id, so clicking the label focuses / toggles it. Omit for
   *  a `SettingsChoice`, which names itself with its own legend. */
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        {htmlFor
          ? <label htmlFor={htmlFor} className="text-sm">{label}</label>
          : <span className="text-sm" aria-hidden="true">{label}</span>}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A small exclusive choice: native radio inputs drawn as a segmented
 *  control, so keyboard arrows and screen readers work as for any radio set. */
export function SettingsChoice<T extends string>({ id, label, value, options, onChange }: {
  id: string;
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset id={id} className="inline-flex rounded-md border p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={`cursor-pointer rounded px-2.5 py-1 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${
            value === option.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          <input
            type="radio"
            name={id}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
