/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mobile's single-panel bottom sheet, plus the visual-viewport inset hook it
 * needs to clear the iOS Safari URL bar overlay. Split out of `ViewerLayout`
 * (#5515) purely to stay under that file's module-size budget — mobile-only,
 * no dependency on the desktop side-by-side layout preset that grew it.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import { capturePointer } from '@/lib/pointer-capture';

/**
 * Tracks the gap between the layout viewport (innerHeight) and the visual
 * viewport: how tall the iOS Safari URL bar overlay (or virtual keyboard) is.
 */
export function useVisualViewportBottomInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const gap = window.innerHeight - vv.height - vv.offsetTop;
      setInset(Math.max(0, Math.round(gap)));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

/**
 * Mobile bottom sheet with three snap states (dismissed / default / expanded).
 * Drag the handle: down to shrink/dismiss, up to enlarge. Velocity-based flicks
 * cross thresholds instantly; otherwise the sheet snaps to the closest state.
 * `bottomInset` lifts the sheet above the iOS Safari URL bar overlay.
 */
export function MobileBottomSheet({
  title,
  onClose,
  bottomInset,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  bottomInset: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startT: number; startHeight: number; active: boolean }>({
    startY: 0,
    startT: 0,
    startHeight: 0,
    active: false,
  });

  const SPRING = 'height 220ms cubic-bezier(0.2, 0, 0, 1)';

  const getSnapPoints = useCallback(() => {
    const h = window.visualViewport?.height ?? window.innerHeight;
    return {
      collapsed: 0,
      defaultH: Math.round(h * 0.6),
      expanded: Math.round(h * 0.92),
    };
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    dragRef.current = { startY: e.clientY, startT: performance.now(), startHeight: sheet.getBoundingClientRect().height, active: true };
    sheet.style.transition = 'none';
    capturePointer(e.currentTarget, e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current;
    if (!dragRef.current.active || !sheet) return;
    const dy = e.clientY - dragRef.current.startY;
    const { expanded } = getSnapPoints();
    const newHeight = Math.max(0, Math.min(expanded, dragRef.current.startHeight - dy));
    sheet.style.height = `${newHeight}px`;
  }, [getSnapPoints]);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current;
    if (!dragRef.current.active || !sheet) return;
    dragRef.current.active = false;
    const dy = e.clientY - dragRef.current.startY;
    const dt = Math.max(1, performance.now() - dragRef.current.startT);
    // Positive velocity = upward drag (intent: enlarge).
    const upwardVelocity = -dy / dt; // px/ms
    const { collapsed, defaultH, expanded } = getSnapPoints();
    const currentHeight = sheet.getBoundingClientRect().height;

    sheet.style.transition = SPRING;

    const snapTo = (h: number) => {
      sheet.style.height = `${h}px`;
    };

    // Velocity-driven decisions take precedence over position.
    if (upwardVelocity > 0.5) {
      snapTo(expanded);
      return;
    }
    if (upwardVelocity < -0.5) {
      // Downward flick: from expanded → default, from default → dismiss.
      if (dragRef.current.startHeight >= expanded - 8) {
        snapTo(defaultH);
      } else {
        snapTo(collapsed);
        window.setTimeout(onClose, 200);
      }
      return;
    }

    // Position-based snap: closest of the three targets.
    const targets: Array<{ state: 'collapsed' | 'default' | 'expanded'; h: number }> = [
      { state: 'collapsed', h: collapsed },
      { state: 'default', h: defaultH },
      { state: 'expanded', h: expanded },
    ];
    let closest = targets[1];
    for (const t of targets) {
      if (Math.abs(currentHeight - t.h) < Math.abs(currentHeight - closest.h)) closest = t;
    }
    snapTo(closest.h);
    if (closest.state === 'collapsed') window.setTimeout(onClose, 200);
  }, [getSnapPoints, onClose]);

  // Initial height = default snap. Recompute when viewport changes (URL bar collapses).
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const { defaultH } = getSnapPoints();
    sheet.style.height = `${defaultH}px`;
  }, [getSnapPoints]);

  return (
    <div
      ref={sheetRef}
      className="absolute inset-x-0 flex flex-col bg-background border-t rounded-t-2xl shadow-2xl z-40 animate-in slide-in-from-bottom duration-300"
      style={{ bottom: `${bottomInset}px` }}
    >
      {/* Drag affordance — generously sized for touch */}
      <div
        className="grid place-items-center pt-3 pb-2 cursor-grab active:cursor-grabbing touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="button"
        aria-label={t('shellChrome.layout.dragToResizeAriaLabel')}
      >
        <div className="w-10 h-1.5 rounded-full bg-muted-foreground/40" />
      </div>
      <div className="flex items-center justify-between px-4 pb-2 shrink-0">
        <span className="font-semibold text-sm">{title}</span>
        <button
          className="p-2 -mr-2 hover:bg-muted rounded-full active:bg-muted/80 touch-manipulation"
          onClick={onClose}
          aria-label={t('viewerShell.dialog.close')}
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto overscroll-contain border-t">
        {children}
      </div>
    </div>
  );
}
