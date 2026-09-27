/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef } from 'react';
import { Check, Copy } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useCopyValue } from './useCopyValue';

/** Hold this long to copy `Name=Value` instead of the value (touch has no Shift). */
const LONG_PRESS_MS = 500;

/**
 * Copy button for one displayed value row (#5900). Click copies the value as
 * shown; Shift+click or a long press copies `Name=Value`. It reveals on row
 * hover/focus (the row carries `group/copyrow`) and stays visible on devices
 * without hover, where there is nothing to reveal it.
 */
export function CopyValueButton({ name, value, className }: { name: string; value: string; className?: string }) {
  const { t } = useTranslation();
  const { copiedKey, copy } = useCopyValue();
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressCopied = useRef(false);
  const endPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const copied = copiedKey !== null;
  return (
    <IconButton
      label={t('properties.copy.valueLabel', { name })}
      tooltip={t('properties.copy.valueTooltip', { name })}
      tooltipSide="left"
      size="icon-xs"
      className={cn(
        'h-6 w-6 shrink-0 p-0 transition-opacity [&_svg]:size-3',
        copied
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-muted-foreground opacity-0 group-hover/copyrow:opacity-100 group-focus-within/copyrow:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
        className,
      )}
      onPointerDown={() => {
        pressCopied.current = false;
        endPress();
        pressTimer.current = setTimeout(() => {
          pressCopied.current = true;
          copy(`${name}=${value}`, 'pair');
        }, LONG_PRESS_MS);
      }}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      onClick={(event) => {
        event.stopPropagation();
        if (pressCopied.current) {
          pressCopied.current = false;
          return;
        }
        copy(event.shiftKey ? `${name}=${value}` : value, event.shiftKey ? 'pair' : 'value');
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </IconButton>
  );
}
