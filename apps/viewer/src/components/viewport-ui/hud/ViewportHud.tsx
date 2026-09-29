/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { VIEW_CUBE_REACH_PX } from '@/components/viewer/viewcube-box';
import { HUD_REGIONS, setHudLaneRulerNode, setHudRegionNode, type HudRegionName } from './hud-regions';

/**
 * Per-region layout: anchor corner/edge, stack alignment, and a safe-area
 * inset per touched edge (`env(safe-area-inset-*)`, `max()`'d against a
 * 1rem/1.5rem floor so an inset-free desktop browser still gets a margin).
 *
 * `top-right` additionally reserves the ViewCube's box (`viewcube-box.ts`:
 * its inset plus its size), so anything placed in this region starts below
 * the cube instead of colliding with it.
 *
 * `bottom-center` used to reserve the always-on Presentation pill and the
 * storey pill, both anchored at `bottom-4 left-1/2` outside the HUD. Both
 * are gone now (#5478 items 22 and 26): the storey pill and hidden count
 * moved into the status bar (#5504), and the Presentation pill became the
 * `presentation` bottom panel (#5508), so this region is back to the same
 * 1rem inset every other edge uses.
 *
 * `top-center` is the lane between two reserves (#5503), and they are not
 * the same width. The LEFT one is 14rem: it holds the status chips (a
 * `HudChip` is capped at 13rem and truncates, so a long model or storey name
 * cannot outgrow it). The RIGHT one is only the ViewCube's reach plus the
 * 1rem edge gap. It used to mirror the left one, which kept ~124px clear of
 * a cube that was never there; with the Model workspace's tool rail in the
 * viewport, those pixels were what the Space Sketch bar's one-row form
 * needed at 1280px (#6315). So the lane is centred in the space BETWEEN the
 * reserves, not on the viewport. Below `left + right` (phones) the offset
 * fades to zero, and the lane collapses to a centred zero-width column just
 * as it did before (`max-width` clamps a negative width to 0).
 *
 * A tool bar wider than the lane wraps (`HudToolbar` is `flex-wrap`) and a
 * card shrinks, instead of sliding under a chip or the cube. Wrapping is the
 * fallback: a bar with lower-priority controls steps down to a narrower
 * one-row form first (`useHudBarTier`, measured against the lane ruler
 * rendered below).
 */
const REGION_CLASSNAME: Record<HudRegionName, string> = {
  'top-left':
    'top-0 left-0 items-start pt-[max(1rem,env(safe-area-inset-top))] pl-[max(1rem,env(safe-area-inset-left))]',
  'top-center':
    'top-0 -translate-x-1/2 items-center pt-[max(1rem,env(safe-area-inset-top))]',
  'top-right':
    'top-0 right-0 items-end pr-[max(1.5rem,env(safe-area-inset-right))]',
  'bottom-left':
    'bottom-0 left-0 items-start pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]',
  'bottom-center':
    'bottom-0 left-1/2 -translate-x-1/2 items-center pb-[max(1rem,env(safe-area-inset-bottom))]',
  'bottom-right':
    'bottom-0 right-0 items-end pb-[max(1rem,env(safe-area-inset-bottom))] pr-[max(1rem,env(safe-area-inset-right))]',
};

/** The top-center lane's reserves (see above). */
const LEFT_RESERVE = '14rem';
const RIGHT_RESERVE = `(${VIEW_CUBE_REACH_PX}px + 1rem)`;

/** Geometry derived from the ViewCube's box, which classes cannot carry. */
const REGION_STYLE: Partial<Record<HudRegionName, CSSProperties>> = {
  'top-center': {
    // Centred between the reserves: shifted right of the viewport's centre by
    // half their difference, faded to no shift once they no longer fit.
    left: `calc(50% + clamp(0px, (100% - ${LEFT_RESERVE} - ${RIGHT_RESERVE}) / 2, (${LEFT_RESERVE} - ${RIGHT_RESERVE}) / 2))`,
    maxWidth: `calc(100% - ${LEFT_RESERVE} - ${RIGHT_RESERVE})`,
  },
  'top-right': { paddingTop: VIEW_CUBE_REACH_PX },
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
 * Consumers portal in through `HudItem`, e.g. the Model workspace's storey
 * chip (`WorkspaceStoreyChip`, #6232) top-left.
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
        style={REGION_STYLE['top-center']}
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
      style={REGION_STYLE[name]}
    />
  );
}
