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

import { useEffect, useRef } from 'react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { HudValueField, type HudValueFieldHandle } from '../../../viewport-ui/hud';
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

export function CommandFieldsBar() {
  const { t } = useTranslation();
  const { command, gesture, fieldRequest } = useCommandRuntime();
  const handles = useRef<(HudValueFieldHandle | null)[]>([]);
  const fields = command?.fields ?? [];

  useEffect(() => {
    if (!fieldRequest) return;
    handles.current[fieldRequest.index]?.beginEdit(fieldRequest.draft);
  }, [fieldRequest]);

  if (fields.length === 0) return null;
  return (
    <>
      {fields.map((field, index) => {
        const format = UNIT_FORMAT[field.unit];
        const label = t(field.labelKey);
        return (
          <div key={field.id} className="flex items-center gap-1" onFocus={() => noteActiveField(index)}>
            <span className="text-2xs text-overlay-ink-muted">{label}</span>
            <HudValueField
              ref={(handle) => { handles.current[index] = handle; }}
              value={field.read(gesture) ?? 0}
              onChange={(next) => writeCommandField(index, next)}
              onSubmit={() => { commitCommand(); }}
              onTab={(shift) => { requestFieldEdit((index + (shift ? -1 : 1) + fields.length) % fields.length); }}
              unit={t(format.key)}
              step={format.step}
              precision={format.precision}
              aria-label={label}
            />
          </div>
        );
      })}
    </>
  );
}
