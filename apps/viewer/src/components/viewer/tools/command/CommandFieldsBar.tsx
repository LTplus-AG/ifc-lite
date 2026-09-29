/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The running modeling command's typed values (length, angle, …) as a row of
 * `HudValueField`s (charter #6232, WP2). Generic over the command: it reads
 * `command.fields` and the gesture from the runtime and writes back through
 * it. Tab (the `command.nextField` key, or Tab inside a field) walks the
 * fields; a digit typed into the viewport opens the active field with that
 * digit; Enter in a field applies the value and commits the command.
 */

import { Fragment, useLayoutEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation, type TranslationKey } from '@/i18n';
import { HudDivider, HudValueField, type HudValueFieldHandle } from '../../../viewport-ui/hud';
import {
  commitCommand,
  noteActiveField,
  requestFieldEdit,
  useCommandRuntime,
  writeCommandField,
} from '@/lib/commands/modeling/runtime';
import type { CommandField } from '@/lib/commands/modeling/types';

const UNIT_FORMAT: Record<CommandField<unknown>['unit'], { key: TranslationKey; step: number; precision: number }> = {
  m: { key: 'modelingCommand.unit.m', step: 0.1, precision: 2 },
  deg: { key: 'modelingCommand.unit.deg', step: 15, precision: 1 },
  count: { key: 'modelingCommand.unit.count', step: 1, precision: 0 },
};

/** The shown field before `index`, wrapping (Shift+Tab). */
function previousShown(fields: readonly CommandField<unknown>[], gesture: unknown, index: number): number {
  let i = index;
  do i = (i - 1 + fields.length) % fields.length; while (i !== index && fields[i].hidden?.(gesture));
  return i;
}

/**
 * `measuring`: an offscreen copy the command bar only measures
 * (`useHudBarTier`). It registers no field handles and ignores field
 * requests, so a typed digit always opens the visible bar's field.
 */
export function CommandFieldsBar({ measuring = false }: { measuring?: boolean } = {}) {
  const { t } = useTranslation();
  const { command, ctx, gesture, fieldRequest } = useCommandRuntime();
  // Dimension fields read the defaults slice; the inspector edits it too.
  useViewerStore((s) => s.authoringDefaults);
  const handles = useRef<(HudValueFieldHandle | null)[]>([]);
  const fields = command?.fields ?? [];

  // Layout effect: the input must mount and take focus before the next key
  // event, or a quickly typed "4.5" loses everything after the "4".
  useLayoutEffect(() => {
    if (!fieldRequest || measuring) return;
    handles.current[fieldRequest.index]?.beginEdit(fieldRequest.draft);
  }, [fieldRequest, measuring]);

  if (fields.length === 0 || !ctx) return null;
  return (
    <>
      {fields.map((field, index) => {
        if (field.hidden?.(gesture)) return null;
        const format = UNIT_FORMAT[field.unit];
        // A field with no value yet shows 0. An untouched field never commits
        // (HudValueField, #6232 F1); a typed 0 there still must not become a
        // lock (a Slab Width of 0 before the first corner). A value typed once
        // the field has one still counts.
        const current = field.read(gesture, ctx);
        const label = t(field.labelKey);
        return (
          <Fragment key={field.id}>
            {index > 0 && fields[index - 1].group !== field.group && !fields[index - 1].hidden?.(gesture) && <HudDivider />}
            <div className="flex items-center gap-1" onFocus={() => noteActiveField(index)}>
              <span className="text-2xs text-overlay-ink-muted">{label}</span>
              <HudValueField
                ref={measuring ? undefined : (handle) => { handles.current[index] = handle; }}
                value={current ?? 0}
                onChange={(next) => { if (current !== null || next !== 0) writeCommandField(index, next); }}
                onSubmit={() => { commitCommand(); }}
                onTab={(shift) => { requestFieldEdit(shift ? previousShown(fields, gesture, index) : (index + 1) % fields.length); }}
                unit={t(format.key)}
                step={format.step}
                precision={format.precision}
                aria-label={label}
              />
            </div>
          </Fragment>
        );
      })}
    </>
  );
}
