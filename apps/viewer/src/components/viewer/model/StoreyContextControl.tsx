/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The storey chip's context control (charter #6232, D9): what 3D does with
 * the storeys above the one being drawn on — "Hide above" (the default),
 * "Ghost above" or "Show all". The icon names the current choice; a click
 * opens the three. The choice is remembered for the browser session
 * (`storeyContextSlice`) and applied by `useVisibilityState`.
 */

import { ArrowDownToLine, Building2, Ghost } from 'lucide-react';
import type { ReactNode } from 'react';
import { useViewerStore } from '@/store';
import { STOREY_CONTEXT_MODES, type StoreyContextMode } from '@/store/slices/storeyContextSlice';
import { useTranslation } from '@/i18n';
import { HudPopover, HudPopoverContent, HudPopoverTrigger, HudSegmented } from '../../viewport-ui/hud';

const ICONS: Record<StoreyContextMode, (className: string) => ReactNode> = {
  hide: (className) => <ArrowDownToLine aria-hidden className={className} />,
  ghost: (className) => <Ghost aria-hidden className={className} />,
  all: (className) => <Building2 aria-hidden className={className} />,
};

export function StoreyContextControl() {
  const { t } = useTranslation();
  const mode = useViewerStore((s) => s.storeyContextMode);
  const setMode = useViewerStore((s) => s.setStoreyContextMode);
  const soloActive = useViewerStore((s) => s.selectedStoreys.size > 0);
  const label = t('storeyContext.button', { mode: t(`storeyContext.state.${mode}`) });

  return (
    <HudPopover>
      <HudPopoverTrigger asChild>
        <button
          type="button"
          data-storey-context={mode}
          aria-label={label}
          title={label}
          className={mode === 'all'
            ? 'shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent'
            : 'shrink-0 rounded-sm p-0.5 text-overlay-accent hover:bg-accent'}
        >
          {ICONS[mode]('h-3.5 w-3.5')}
        </button>
      </HudPopoverTrigger>
      <HudPopoverContent align="start" className="flex flex-col gap-1.5">
        <div className="px-0.5 text-2xs font-medium text-muted-foreground">{t('storeyContext.group')}</div>
        <HudSegmented<StoreyContextMode>
          aria-label={t('storeyContext.group')}
          value={mode}
          onChange={setMode}
          options={STOREY_CONTEXT_MODES.map((value) => ({
            value,
            icon: ICONS[value]('h-3 w-3'),
            label: t(`storeyContext.mode.${value}`),
          }))}
        />
        {soloActive && <div className="px-0.5 text-2xs text-muted-foreground">{t('storeyContext.soloActive')}</div>}
      </HudPopoverContent>
    </HudPopover>
  );
}
