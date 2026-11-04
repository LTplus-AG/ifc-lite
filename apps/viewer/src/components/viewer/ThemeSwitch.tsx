/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { forwardRef, type ComponentPropsWithoutRef, type MouseEvent } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
 *
 * Forwards its ref and extra props so a Radix `TooltipTrigger asChild` can
 * wrap it directly.
 */
export const ThemeSwitch = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Button>>(
  function ThemeSwitch({ onClick, ...props }, ref) {
    const { t } = useTranslation();
    const theme = useViewerStore((s) => s.theme);
    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      const store = useViewerStore.getState();
      if (event.shiftKey) store.toggleColorful();
      else store.toggleTheme();
    };
    return (
      <Button
        ref={ref}
        variant="ghost"
        size="icon-xs"
        aria-label={t('ribbon.themeAriaLabel')}
        data-theme-switch={theme}
        {...props}
        onClick={handleClick}
      >
        {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      </Button>
    );
  },
);
