/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react';
import { cn } from '@/lib/utils';
import { HUD_REGIONS, setHudLaneRulerNode, setHudRegionNode, type HudRegionName } from './hud-regions';

/**
 * Per-region layout: anchor corner/edge, stack alignment, and a safe-area
 * inset per touched edge (`env(safe-area-inset-*)`, `max()`'d against a
 * 1rem/1.5rem floor so an inset-free desktop browser still gets a margin).
 *
 * `top-right` additionally reserves the 60px ViewCube box anchored at
 * `top-6 right-6` (`ViewportOverlays.tsx` ~284-302, unmoved by this PR): 24px
 * inset + 60px cube = 84px, so anything placed in this region starts below
 * the cube instead of colliding with it.
 *
 * `bottom-center` used to reserve the always-on Presentation pill and the
 * storey pill, both anchored at `bottom-4 left-1/2` outside the HUD. Both
 * are gone now (#5478 items 22 and 26): the storey pill and hidden count
 * moved into the status bar (#5504), and the Presentation pill became the
 * `presentation` bottom panel (#5508), so this region is back to the same
 * 1rem inset every other edge uses.
 *
 * `top-center` is capped at the viewport width minus a 14rem lane on each
 * side (#5503): the left lane holds the status chips (a `HudChip` is capped
 * at 13rem and truncates, so a long model name in the Editing chip cannot
 * outgrow the lane), the right lane the ViewCube. A tool bar wider than what
 * is left wraps (`HudToolbar` is `flex-wrap`) and a card shrinks, instead of
 * sliding under either — the Space Sketch bar and plan card did exactly that
 * at 1600px / 1280px with both side panels open. Wrapping is the fallback: a
 * bar with lower-priority controls steps down to a narrower one-row form
 * first (`useHudBarTier`, measured against the lane ruler rendered below).
 */
const REGION_CLASSNAME: Record<HudRegionName, string> = {
  'top-left':
    'top-0 left-0 items-start pt-[max(1rem,env(safe-area-inset-top))] pl-[max(1rem,env(safe-area-inset-left))]',
  'top-center':
    'top-0 left-1/2 -translate-x-1/2 items-center pt-[max(1rem,env(safe-area-inset-top))] max-w-[calc(100%-28rem)]',
  'top-right':
    'top-0 right-0 items-end pt-[84px] pr-[max(1.5rem,env(safe-area-inset-right))]',
  'bottom-left':
    'bottom-0 left-0 items-start pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]',
  'bottom-center':
    'bottom-0 left-1/2 -translate-x-1/2 items-center pb-[max(1rem,env(safe-area-inset-bottom))]',
  'bottom-right':
    'bottom-0 right-0 items-end pb-[max(1rem,env(safe-area-inset-bottom))] pr-[max(1rem,env(safe-area-inset-right))]',
};

/**
 * Six-region HUD host for the 3D viewport (#5485, charter #5478 item 3).
 *
 * Screen-space chrome — a tool's bar, status chips, one hint line,
 * navigation — is placed by REGION + ORDER (`HudItem`), never by `absolute`
 * coordinates, so two items can never land on the same pixels: each region
 * is an ordinary flex column, and normal-flow flex children stack, they
 * don't overlap. Layout resolves collisions; this component only owns the
 * six regions' geometry.
 *
 * The whole host, and every region, is `pointer-events-none` so empty space
 * between controls never steals an orbit/pan gesture from the 3D canvas
 * underneath. Each interactive control opts back in with
 * `pointer-events-auto` (`HudSurface`); a passive one (`HudHint`) does not.
 *
 * Mounted once from `ViewportOverlays` (inside the viewport panel), so a
 * docked bottom panel that shrinks the viewport shrinks this with it instead
 * of being covered by it — no separate sizing logic needed here.
 *
 * Consumers portal in through `HudItem`; the first is the edit-mode chip
 * (`EditModeHudChip`, #5489). The remaining overlays migrate in later items.
 */
export function ViewportHud() {
  return (
    <div className="pointer-events-none absolute inset-0 z-(--z-hud)" data-testid="viewport-hud">
      {HUD_REGIONS.map((name) => (
        <HudRegionSlot key={name} name={name} />
      ))}
      {/* The top-center lane ruler (#5975): same classes as the region, but
          `w-full` and childless, so its width IS the lane cap. */}
      <div
        ref={setHudLaneRulerNode}
        aria-hidden="true"
        className={cn('pointer-events-none invisible absolute h-0 w-full', REGION_CLASSNAME['top-center'])}
      />
    </div>
  );
}

function HudRegionSlot({ name }: { name: HudRegionName }) {
  // Stable per mounted instance: `name` never changes across this
  // component's lifetime, so React calls this ref exactly once with the
  // node (mount) and once with `null` (unmount) — never spuriously.
  const ref = useCallback((node: HTMLDivElement | null) => setHudRegionNode(name, node), [name]);
  return (
    <div
      ref={ref}
      data-hud-region={name}
      className={cn('pointer-events-none absolute flex flex-col gap-2', REGION_CLASSNAME[name])}
    />
  );
}
