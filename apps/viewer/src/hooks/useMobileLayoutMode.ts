/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mobile/desktop layout mode, and the panel collapse that belongs to ENTERING
 * mobile mode.
 *
 * On a phone `resize` fires for the on-screen keyboard, the URL bar showing or
 * hiding, and rotation. The collapse used to run on every one of them, so
 * focusing a text field inside the open bottom sheet opened the keyboard, and
 * the keyboard closed the sheet (#5837). The collapse now runs only when the
 * mode changes into mobile (the first mobile mount included); resizes that
 * stay mobile leave the open sheet alone.
 */

import { useEffect } from 'react';
import { useViewerStore } from '@/store';

/** Narrow screens, and touch screens up to tablet width, use the mobile layout. */
function isMobileViewport(width: number, hasTouchScreen: boolean): boolean {
  return width < 768 || (hasTouchScreen && width < 1024);
}

export function useMobileLayoutMode(): void {
  const setIsMobile = useViewerStore((s) => s.setIsMobile);
  const setLeftPanelCollapsed = useViewerStore((s) => s.setLeftPanelCollapsed);
  const setRightPanelCollapsed = useViewerStore((s) => s.setRightPanelCollapsed);

  useEffect(() => {
    let previous: boolean | null = null;
    const checkMobile = () => {
      const hasTouchScreen = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      const mobile = isMobileViewport(window.innerWidth, hasTouchScreen);
      if (mobile === previous) return;
      previous = mobile;
      setIsMobile(mobile);
      if (mobile) {
        setLeftPanelCollapsed(true);
        setRightPanelCollapsed(true);
      }
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [setIsMobile, setLeftPanelCollapsed, setRightPanelCollapsed]);
}
