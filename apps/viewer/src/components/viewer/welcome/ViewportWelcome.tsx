/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The no-model start screen: the action column on the left and, when the
 * viewport is wide enough, the layered 3D mark on the right.
 *
 * Width is measured on this element, not the window: with Hierarchy and
 * Properties open the viewport is far narrower than the screen, and a phone is
 * narrower still. Below `SCENE_MIN_WIDTH` the mark is not mounted at all, so a
 * narrow layout never spends a WebGL context (or the three.js chunk) on it.
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ViewportWelcomeCard, type ViewportWelcomeCardProps } from '../ViewportWelcomeCard';
import { WelcomeFooterChips } from '../WelcomeFooterChips';

/** Viewport width (px) from which the 3D mark has room beside the actions. */
const SCENE_MIN_WIDTH = 720;

// A chunk that fails to load (offline, a stale deploy) must cost the mark,
// never the start screen: resolve to an empty component instead of throwing
// into the nearest error boundary.
const WelcomeLayerScene = lazy(() =>
  import('./WelcomeLayerScene').catch((err: unknown) => {
    console.warn('[welcome] 3D mark chunk failed to load; showing the start screen without it', err);
    return { default: () => null };
  }),
);

export function ViewportWelcome(props: ViewportWelcomeCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= SCENE_MIN_WIDTH));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="flex w-full max-w-6xl flex-col">
      <div className={wide ? 'grid grid-cols-[minmax(0,500px)_minmax(0,1fr)] items-center gap-8' : 'flex justify-center'}>
        <ViewportWelcomeCard {...props} />
        {wide && (
          <div className="h-[min(560px,64vh)] min-h-[320px]">
            <Suspense fallback={null}>
              <WelcomeLayerScene />
            </Suspense>
          </div>
        )}
      </div>
      <WelcomeFooterChips tourAvailable={props.webgpu.supported && !props.webgpu.checking} />
    </div>
  );
}
