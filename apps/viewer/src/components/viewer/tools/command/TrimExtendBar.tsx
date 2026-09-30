/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.trimExtend`'s bar (charter #6232, C1): the Trim / Extend switch
 * (Shift flips it for one click), the boundary once it is picked, and what a
 * click on the element under the cursor would do.
 */

import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { updateCommandGesture } from '@/lib/commands/modeling/runtime';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { effectiveMode, type TrimExtendGesture } from '@/lib/commands/modeling/commands/trim-extend';
import type { ReachMode } from '@/lib/commands/modeling/commands/trim-extend-geometry';
import { HudDivider, HudSegmented } from '../../../viewport-ui/hud';

export function TrimExtendBar({ gesture }: CommandHudProps<TrimExtendGesture>) {
  const { t, locale } = useTranslation();
  const { boundary, preview } = gesture;
  const mode = effectiveMode(gesture);
  return (
    <>
      <HudDivider />
      <HudSegmented
        aria-label={t('trimExtend.mode.label')}
        options={[
          { value: 'trim', label: t('trimExtend.mode.trim'), title: t('trimExtend.mode.trimTitle') },
          { value: 'extend', label: t('trimExtend.mode.extend'), title: t('trimExtend.mode.extendTitle') },
        ]}
        // Shift shows through: the switch reads what a click does now.
        value={mode}
        onChange={(next: ReachMode) => updateCommandGesture((g) => ({ ...(g as TrimExtendGesture), mode: next, shift: false }))}
      />
      <HudDivider />
      <span className="whitespace-nowrap px-1 text-xs text-muted-foreground" data-trim-extend="boundary" data-picked={boundary ? 'true' : 'false'}>
        {boundary ? t('trimExtend.bar.boundary', { name: boundary.label }) : t('trimExtend.bar.pickBoundary')}
      </span>
      {preview && (
        <>
          <HudDivider />
          {preview.ok ? (
            <span className="whitespace-nowrap px-1 text-xs tabular-nums text-overlay-accent" data-trim-extend="result" data-op={preview.op} data-join={preview.joinKind ?? ''}>
              {t(preview.op === 'trim' ? 'trimExtend.bar.trim' : 'trimExtend.bar.extend', { distance: formatLocaleNumber(locale, Math.abs(preview.moved), { maximumFractionDigits: 2 }) })}
              {preview.joinKind ? ` · ${t('trimExtend.bar.join', { kind: preview.joinKind })}` : ''}
            </span>
          ) : (
            <span className="max-w-[20rem] truncate px-1 text-xs text-status-danger" data-trim-extend="refused" title={preview.reason}>
              {preview.reason}
            </span>
          )}
        </>
      )}
    </>
  );
}
