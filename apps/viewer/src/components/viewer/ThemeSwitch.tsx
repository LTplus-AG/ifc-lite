/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MouseEvent } from 'react';
import { Moon, Sun } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';

/**
 * The header's theme toggle: a monochrome sun / moon icon button in the same
 * ghost style as Help and Settings beside it (#8802 R1; the illustrated sky
 * pill it replaces was the most saturated thing in the chrome).
 *
 * The icon names the theme a click switches TO. Shift+click keeps toggling
 * the hidden "colorful" theme; a plain click from colorful drops to dark,
 * exactly as `toggleTheme` defines.
 */
export function ThemeSwitch() {
  const { t } = useTranslation();
  const theme = useViewerStore((s) => s.theme);
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    const store = useViewerStore.getState();
    if (event.shiftKey) store.toggleColorful();
    else store.toggleTheme();
  };
  return (
    <IconButton
      size="icon-xs"
      label={t('ribbon.themeAriaLabel')}
      tooltip={t('ribbon.themeTooltip')}
      data-theme-switch={theme}
      onClick={handleClick}
    >
      {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </IconButton>
  );
}
