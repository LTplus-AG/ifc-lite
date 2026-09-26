/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Pin`: a teardrop marker anchored to a world point — annotation pins,
 * BCF viewpoint markers, peer cursors. Status-coloured when `status` is
 * given (matches BCF/clash state tokens); otherwise ink/accent like every
 * other passive/active primitive. `fill` overrides both for data-driven
 * identity colour (e.g. a collab peer's own colour, #5511) that must stay
 * out of the shared token palette (roadmap §3: "data palettes stay data").
 *
 * Passive by default — the root `<g>` only turns `pointer-events-auto` when
 * a click/context-menu handler is given, matching `Handle`'s pattern of
 * opting individual primitives back into hit-testing against the
 * `pointer-events-none` overlay root.
 */

import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useSceneLayer } from '../SceneLayers';
import { useWorldAnchor } from '../useWorldAnchor';
import type { Vec3 } from '../types';

export type PinStatus = 'danger' | 'warn' | 'ok' | 'info';

const STATUS_FILL_CLASS: Record<PinStatus, string> = {
  danger: 'fill-status-danger',
  warn: 'fill-status-warn',
  ok: 'fill-status-ok',
  info: 'fill-status-info',
};

export interface PinProps {
  worldPoint: Vec3 | null;
  active?: boolean;
  status?: PinStatus;
  /** Rendered centred inside the pin head (e.g. an initial or count). */
  children?: React.ReactNode;
  className?: string;
  /** Explicit CSS colour overriding the ink/accent/status fill classes. */
  fill?: string;
  /** Native SVG `<title>` tooltip; also the group's `aria-label` when interactive. */
  title?: string;
  onClick?: React.MouseEventHandler<SVGGElement>;
  onContextMenu?: React.MouseEventHandler<SVGGElement>;
  /**
   * Extra attributes spread onto the anchored `<g>` — e.g. a `data-*` hook a
   * consumer's own outside-click detection needs, or an inline `style`
   * (peer-cursor fade). `SVGAttributes` alone rejects arbitrary `data-*`
   * keys in a plain object literal (unlike a JSX intrinsic element, which
   * special-cases them) — the index signature widens it back.
   */
  groupProps?: React.SVGAttributes<SVGGElement> & Record<`data-${string}`, string | undefined>;
}

// Teardrop path: circular head at the origin, point 22px below.
const PIN_PATH = 'M0,-22 C6,-22 11,-17 11,-11 C11,-4 0,0 0,0 C0,0 -11,-4 -11,-11 C-11,-17 -6,-22 0,-22 Z';

export function Pin({
  worldPoint,
  active = false,
  status,
  children,
  className,
  fill,
  title,
  onClick,
  onContextMenu,
  groupProps,
}: PinProps) {
  const svgLayer = useSceneLayer('svg');
  const { ref } = useWorldAnchor<SVGGElement>(() => worldPoint);

  if (!svgLayer) return null;

  const fillClass = fill ? undefined : status ? STATUS_FILL_CLASS[status] : active ? 'fill-overlay-accent' : 'fill-overlay-ink';
  const interactive = Boolean(onClick || onContextMenu);

  return createPortal(
    <g
      ref={ref}
      data-scene-primitive="pin"
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'button' : undefined}
      aria-label={interactive ? title : undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
      {...groupProps}
      // `useWorldAnchor` owns `display` (hidden until the first dirty tick
      // projects it) by writing straight to `ref.current.style` — merged
      // here, AFTER the spread, so a `groupProps.style` (e.g. a peer's fade
      // opacity) augments it instead of replacing the whole `style` object
      // and silently deleting the hidden-until-projected `display: none`.
      style={{ ...groupProps?.style, display: 'none' }}
      className={cn(
        interactive && 'pointer-events-auto cursor-pointer outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-overlay-accent',
        groupProps?.className,
      )}
    >
      <path d={PIN_PATH} style={fill ? { fill } : undefined} className={cn('stroke-overlay-halo stroke-2', fillClass, className)}>
        {title ? <title>{title}</title> : null}
      </path>
      {children ? (
        <g transform="translate(0, -11)" className="fill-overlay-halo pointer-events-none text-2xs">
          {children}
        </g>
      ) : null}
    </g>,
    svgLayer,
  );
}
