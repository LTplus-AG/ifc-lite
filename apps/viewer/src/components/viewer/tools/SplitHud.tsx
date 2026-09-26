/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Split tool's `TOOL_HUD` row (#5503): a bar that names the tool and
 * closes it (touch users have no Esc), and the scene layer — the SVG cut
 * preview plus the cursor-anchored distance entry. The two scene parts are
 * siblings rather than nested so the SVG layer stays `pointer-events-none`
 * while the input is interactive.
 */

import { X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { HudToolbar } from '../../viewport-ui/hud';
import { SplitOverlay } from './SplitOverlay';
import { SplitCursorInput } from './SplitCursorInput';

export function SplitBar() {
  const { t } = useTranslation();
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  return (
    <HudToolbar>
      <span className="px-1.5 text-2xs font-medium uppercase tracking-wide text-overlay-ink-muted">
        {t('splitTool.barLabel')}
      </span>
      <button
        type="button"
        onClick={() => setActiveTool('select')}
        aria-label={t('splitTool.closeAria')}
        title={t('splitTool.closeAria')}
        className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <X aria-hidden className="h-3.5 w-3.5" />
      </button>
    </HudToolbar>
  );
}

export function SplitScene() {
  return (
    <>
      <SplitOverlay />
      <SplitCursorInput />
    </>
  );
}
