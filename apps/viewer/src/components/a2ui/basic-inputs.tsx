/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Basic-catalog inputs on the viewer's primitives. Values are two-way bound:
 * the generic binder hands each bound prop a `setX` that writes the surface's
 * data model, which `Event` contexts and queries then read.
 */

import { useId, useState } from 'react';
import { createComponentImplementation } from '@a2ui/react';
import { ButtonApi, CheckBoxApi, ChoicePickerApi, SliderApi, TextFieldApi } from '@a2ui/web_core/v1_0';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { reportActionError } from './runtime';
import { weightStyle } from './basic-layout';

function ValidationErrors({ errors }: { errors?: string[] }) {
  if (!errors?.length) return null;
  return <p role="alert" className="text-xs text-destructive">{errors.join(' ')}</p>;
}

export const ButtonImpl = createComponentImplementation(ButtonApi, ({ props, buildChild }) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const variant = props.variant === 'primary' ? 'default' : props.variant === 'borderless' ? 'ghost' : 'outline';
  return (
    <div style={weightStyle(props.weight)}>
      <Button
        size="sm"
        variant={variant}
        disabled={busy || props.isValid === false}
        onClick={() => {
          if (typeof props.action !== 'function') return;
          setBusy(true);
          props.action().catch((error: unknown) => reportActionError(error, t)).finally(() => setBusy(false));
        }}
        className="[&_p]:my-0"
      >
        {typeof props.child === 'string' ? buildChild(props.child) : null}
      </Button>
      <ValidationErrors errors={props.validationErrors} />
    </div>
  );
});

export const TextFieldImpl = createComponentImplementation(TextFieldApi, ({ props }) => {
  const id = useId();
  const value = typeof props.value === 'string' ? props.value : '';
  const common = {
    id,
    value,
    placeholder: typeof props.placeholder === 'string' ? props.placeholder : undefined,
    'aria-invalid': props.isValid === false || undefined,
  };
  return (
    <div style={weightStyle(props.weight)} className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">{String(props.label ?? '')}</Label>
      {props.variant === 'longText' ? (
        <Textarea {...common} rows={3} onChange={(e) => props.setValue(e.target.value)} />
      ) : (
        <Input
          {...common}
          type={props.variant === 'number' ? 'number' : props.variant === 'obscured' ? 'password' : 'text'}
          onChange={(e) => props.setValue(e.target.value)}
          className="h-8"
        />
      )}
      <ValidationErrors errors={props.validationErrors} />
    </div>
  );
});

export const CheckBoxImpl = createComponentImplementation(CheckBoxApi, ({ props }) => (
  <div style={weightStyle(props.weight)}>
    <Checkbox checked={props.value === true} onCheckedChange={(checked) => props.setValue(checked)} label={String(props.label ?? '')} />
    <ValidationErrors errors={props.validationErrors} />
  </div>
));

export const ChoicePickerImpl = createComponentImplementation(ChoicePickerApi, ({ props }) => {
  const groupId = useId();
  const [filter, setFilter] = useState('');
  const selected = Array.isArray(props.value) ? props.value.map(String) : [];
  const multiple = props.variant !== 'mutuallyExclusive';
  const options = (Array.isArray(props.options) ? props.options : [])
    .filter((o) => !filter || String(o.label).toLowerCase().includes(filter.toLowerCase()));
  const toggle = (value: string) => {
    if (!multiple) return props.setValue([value]);
    props.setValue(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };
  const label = typeof props.label === 'string' ? props.label : undefined;
  return (
    <div style={weightStyle(props.weight)} className="flex flex-col gap-1.5">
      {label && <span id={groupId} className="text-xs font-medium">{label}</span>}
      {props.filterable && <Input value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={label} className="h-7" />}
      <div role={multiple ? 'group' : 'radiogroup'} aria-labelledby={label ? groupId : undefined} className={cn('flex gap-1.5', props.displayStyle === 'chips' ? 'flex-row flex-wrap' : 'flex-col')}>
        {options.map((o) => {
          const on = selected.includes(o.value);
          return props.displayStyle === 'chips' ? (
            <Button
              key={o.value}
              size="segment"
              variant="toggle"
              role={multiple ? undefined : 'radio'}
              aria-pressed={multiple ? on : undefined}
              aria-checked={multiple ? undefined : on}
              onClick={() => toggle(o.value)}
              className="border"
            >
              {String(o.label)}
            </Button>
          ) : (
            <Checkbox key={o.value} checked={on} onCheckedChange={() => toggle(o.value)} label={String(o.label)} />
          );
        })}
      </div>
      <ValidationErrors errors={props.validationErrors} />
    </div>
  );
});

export const SliderImpl = createComponentImplementation(SliderApi, ({ props }) => {
  const id = useId();
  const min = typeof props.min === 'number' ? props.min : 0;
  const max = typeof props.max === 'number' ? props.max : 100;
  const value = typeof props.value === 'number' ? props.value : min;
  const step = typeof props.steps === 'number' && props.steps > 0 ? (max - min) / props.steps : 'any';
  return (
    <div style={weightStyle(props.weight)} className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <Label htmlFor={id} className="text-xs">{String(props.label ?? '')}</Label>
        <output htmlFor={id} className="tabular-nums text-muted-foreground">{value.toLocaleString()}</output>
      </div>
      <Input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => props.setValue(Number(e.target.value))} className="h-5 border-0 p-0 shadow-none accent-primary" />
      <ValidationErrors errors={props.validationErrors} />
    </div>
  );
});
