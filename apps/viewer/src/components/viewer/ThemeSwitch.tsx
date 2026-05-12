/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useCallback } from 'react';
import { ThemeToggle } from 'beautiful-theme-toggle';
import { useViewerStore } from '@/store';

/**
 * Animated SVG theme toggle (sun/moon) powered by beautiful-theme-toggle.
 *
 * Bidirectional sync:
 *  - User clicks the widget  → onChange → store.setTheme
 *  - External change (keyboard shortcut / command palette) → store updates → widget.setTheme
 *
 * Secret colorful mode:
 *  - Hold Shift while clicking → toggles the hidden "colorful" theme
 *  - The sun/moon widget can't represent a third state, so it shows "sun" (day vibes)
 *    while the colorful gradient takes over the world.
 */
export function ThemeSwitch() {
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<ThemeToggle | null>(null);
  // Track whether Shift was held during the click so we can intercept in onChange
  const shiftHeldRef = useRef(false);

  // Capture shift key state on pointerdown (fires before the widget's internal click handler)
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    shiftHeldRef.current = e.shiftKey;
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const currentTheme = useViewerStore.getState().theme;

    const toggle = new ThemeToggle({
      element: containerRef.current,
      size: 80,
      // Colorful → show sun (it's a bright/day-ish theme)
      initialState: currentTheme === 'dark' ? 'dark' : 'light',
      onChange: (widgetState) => {
        const store = useViewerStore.getState();

        if (shiftHeldRef.current) {
          // Secret shift-click: toggle colorful mode
          shiftHeldRef.current = false;
          store.toggleColorful();

          // Sync widget visual: colorful → sun, otherwise follow the new theme
          const newTheme = useViewerStore.getState().theme;
          const widgetTarget = newTheme === 'dark' ? 'dark' : 'light';
          if (toggleRef.current && toggleRef.current.getTheme() !== widgetTarget) {
            toggleRef.current.setTheme(widgetTarget, false);
          }
          return;
        }

        // Normal click: dark ↔ light (if colorful, drops to dark)
        shiftHeldRef.current = false;
        store.toggleTheme();

        // The widget already animated to widgetState, but toggleTheme may have
        // produced a different result (e.g. colorful → dark). Reconcile:
        const newTheme = useViewerStore.getState().theme;
        const expectedWidget = newTheme === 'dark' ? 'dark' : 'light';
        if (toggleRef.current && widgetState !== expectedWidget) {
          toggleRef.current.setTheme(expectedWidget, false);
        }
      },
    });

    toggleRef.current = toggle;

    // Subscribe to external theme changes so the widget stays in sync
    let prevTheme = currentTheme;
    const unsub = useViewerStore.subscribe((state) => {
      if (state.theme !== prevTheme) {
        prevTheme = state.theme;
        const widgetTarget = state.theme === 'dark' ? 'dark' : 'light';
        if (toggleRef.current && toggleRef.current.getTheme() !== widgetTarget) {
          toggleRef.current.setTheme(widgetTarget, false);
        }
      }
    });

    return () => {
      unsub();
      toggle.destroy();
      toggleRef.current = null;
    };
  }, []);

  const theme = useViewerStore((s) => s.theme);
  const isColorful = theme === 'colorful';

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      className={`flex items-center cursor-pointer transition-all duration-300 ${
        isColorful
          ? 'opacity-100 scale-110'
          : 'opacity-80 hover:opacity-100'
      }`}
      style={isColorful ? {
        filter: 'drop-shadow(0 0 6px rgba(157,124,216,0.5)) drop-shadow(0 0 12px rgba(255,158,100,0.25))',
      } : undefined}
    />
  );
}
