/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The window's form factor (#9718), and the panel collapse that belongs to
 * ENTERING mobile mode.
 *
 * The classification is `classifyFormFactor`'s; this hook only feeds it the
 * window: size, whether the primary pointer is coarse, and the Viewport
 * Segments API's fold segments where the browser has it. It re-reads them on
 * `resize` (rotation, folding and unfolding all fire it) and when the
 * pointer media query changes (a keyboard cover attached or removed).
 *
 * On a phone `resize` also fires for the on-screen keyboard and the URL bar
 * showing or hiding. The collapse used to run on every one of them, so
 * focusing a text field inside the open bottom sheet opened the keyboard, and
 * the keyboard closed the sheet (#5837). The collapse runs only when the mode
 * changes into mobile (the first mobile mount included); resizes that stay
 * mobile, from one form factor to another included, leave the open sheet alone.
 */

import { useEffect } from 'react';
import { useViewerStore } from '@/store';
import { classifyFormFactor, type FormFactor } from '@/lib/layout/form-factor';

const COARSE_POINTER = '(pointer: coarse)';

function coarsePointerQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(COARSE_POINTER) : null;
}

function readFormFactor(coarse: MediaQueryList | null): FormFactor {
  // Without matchMedia, a touch screen stands in for a coarse pointer.
  const coarsePointer = coarse ? coarse.matches : 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  return classifyFormFactor({
    width: window.innerWidth,
    height: window.innerHeight,
    coarsePointer,
    segments: window.viewport?.segments ?? null,
  });
}

/** Same classification, so an unchanged window does not re-render the shell. */
function sameFormFactor(a: FormFactor, b: FormFactor): boolean {
  if (a.mode !== b.mode || a.compactCommands !== b.compactCommands || a.fold?.orientation !== b.fold?.orientation) return false;
  const [sa, sb] = [a.fold?.segments ?? [], b.fold?.segments ?? []];
  return sa.every((r, i) => r.x === sb[i].x && r.y === sb[i].y && r.width === sb[i].width && r.height === sb[i].height);
}

export function useMobileLayoutMode(): void {
  const setFormFactor = useViewerStore((s) => s.setFormFactor);
  const setLeftPanelCollapsed = useViewerStore((s) => s.setLeftPanelCollapsed);
  const setRightPanelCollapsed = useViewerStore((s) => s.setRightPanelCollapsed);

  useEffect(() => {
    const coarse = coarsePointerQuery();
    let previous: FormFactor | null = null;
    const check = () => {
      const next = readFormFactor(coarse);
      if (previous && sameFormFactor(previous, next)) return;
      const enteringMobile = next.mode !== 'desktop' && (previous === null || previous.mode === 'desktop');
      previous = next;
      setFormFactor(next);
      if (enteringMobile) {
        setLeftPanelCollapsed(true);
        setRightPanelCollapsed(true);
      }
    };

    check();
    window.addEventListener('resize', check);
    coarse?.addEventListener('change', check);
    return () => {
      window.removeEventListener('resize', check);
      coarse?.removeEventListener('change', check);
    };
  }, [setFormFactor, setLeftPanelCollapsed, setRightPanelCollapsed]);
}
