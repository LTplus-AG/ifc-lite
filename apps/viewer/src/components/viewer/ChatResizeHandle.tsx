/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { KeyboardEvent, MouseEvent } from 'react';
import { useTranslation } from '@/i18n';

interface ChatResizeHandleProps {
  width: number;
  onWidthChange: (width: number) => void;
  onMouseDown: (event: MouseEvent) => void;
}

export function ChatResizeHandle({ width, onWidthChange, onMouseDown }: ChatResizeHandleProps) {
  const { t } = useTranslation();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = width + 20; break;
      case 'ArrowRight': next = width - 20; break;
      case 'Home': next = 240; break;
      case 'End': next = 700; break;
      default: return;
    }
    event.preventDefault();
    onWidthChange(Math.min(700, Math.max(240, next)));
  };

  return (
    <div
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      tabIndex={0}
      // This separator changes the pane width; a decorative <hr> cannot be operated by keyboard.
      // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="separator"
      aria-orientation="vertical"
      aria-label={t('scriptPanel.chat.resizeAriaLabel')}
      aria-valuemin={240}
      aria-valuemax={700}
      aria-valuenow={width}
      className="w-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 focus-visible:outline-2 focus-visible:outline-primary transition-colors cursor-col-resize shrink-0 h-full"
    />
  );
}
