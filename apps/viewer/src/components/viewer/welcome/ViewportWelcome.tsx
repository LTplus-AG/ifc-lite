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
 *
 * The mark also waits for the first quiet moment after the start screen is up
 * (`useMarkMayStart`), and never starts once a model open was asked for: the
 * pick itself cancels it, before `loading` flips.
 * Creating its WebGL context and linking its shaders are synchronous round
 * trips to the GPU process: about 40 ms on ANGLE/Metal, but 2-3 s right after
 * first paint where ANGLE runs on Vulkan or on a software GL. A file picked as
 * soon as the screen appears must not queue behind that.
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ViewportWelcomeCard, type ViewportWelcomeCardProps } from '../ViewportWelcomeCard';
import { WelcomeFooterChips } from '../WelcomeFooterChips';
import { msSinceLoadIntent, subscribeLoadIntent } from '@/lib/load-intent';
import { whenQuiet } from './welcome-mark-schedule';

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

/** A load intent holds the mark back this long: the open it announced unmounts this screen well before. */
export const INTENT_HOLD_MS = 10_000;
/** Upper bound on the wait for a quiet main thread before the mark starts anyway. */
export const MARK_IDLE_TIMEOUT_MS = 2000;

/**
 * True once the mark may start: the main thread was quiet after mount
 * (`whenQuiet`) and no model open was asked for within `INTENT_HOLD_MS`.
 * A pick, drop or Open click (`markLoadIntent`) cancels the pending start at
 * once, before any await on the way to `loading`; if no load follows (the
 * picker was cancelled), the mark gets its turn after the hold.
 */
function useMarkMayStart(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelQuiet = () => {};
    let hold = 0;
    const holdFor = (ms: number) => { cancelQuiet(); window.clearTimeout(hold); hold = window.setTimeout(arm, ms); };
    function arm() {
      cancelQuiet();
      cancelQuiet = whenQuiet(() => {
        const since = msSinceLoadIntent();
        if (since < INTENT_HOLD_MS) holdFor(INTENT_HOLD_MS - since);
        else setReady(true);
      }, MARK_IDLE_TIMEOUT_MS);
    }
    const unsubscribe = subscribeLoadIntent(() => holdFor(INTENT_HOLD_MS));
    const since = msSinceLoadIntent();
    if (since < INTENT_HOLD_MS) holdFor(INTENT_HOLD_MS - since);
    else arm();
    return () => { cancelQuiet(); window.clearTimeout(hold); unsubscribe(); };
  }, []);
  return ready;
}

export function ViewportWelcome(props: ViewportWelcomeCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const idle = useMarkMayStart();

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
          <div className="h-[min(560px,64vh)] min-h-[320px]" data-welcome-mark={idle ? 'mounted' : 'deferred'}>
            {idle && (
              <Suspense fallback={null}>
                <WelcomeLayerScene />
              </Suspense>
            )}
          </div>
        )}
      </div>
      <WelcomeFooterChips tourAvailable={props.webgpu.supported && !props.webgpu.checking} />
    </div>
  );
}
