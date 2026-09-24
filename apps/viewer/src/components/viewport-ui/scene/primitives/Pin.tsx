/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Pin`: a teardrop marker anchored to a world point — annotation pins,
 * BCF viewpoint markers, peer cursors. Status-coloured when `status` is
 * given (matches BCF/clash state tokens); otherwise ink/accent like every
 * other passive/active primitive.
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
}

// Teardrop path: circular head at the origin, point 22px below.
const PIN_PATH = 'M0,-22 C6,-22 11,-17 11,-11 C11,-4 0,0 0,0 C0,0 -11,-4 -11,-11 C-11,-17 -6,-22 0,-22 Z';

export function Pin({ worldPoint, active = false, status, children, className }: PinProps) {
  const svgLayer = useSceneLayer('svg');
  const { ref } = useWorldAnchor<SVGGElement>(() => worldPoint);

  if (!svgLayer) return null;

  const fillClass = status ? STATUS_FILL_CLASS[status] : active ? 'fill-overlay-accent' : 'fill-overlay-ink';

  return createPortal(
    <g ref={ref} style={{ display: 'none' }} data-scene-primitive="pin">
      <path d={PIN_PATH} className={cn('stroke-overlay-halo stroke-2', fillClass, className)} />
      {children ? (
        <g transform="translate(0, -11)" className="fill-overlay-halo pointer-events-none text-[9px]">
          {children}
        </g>
      ) : null}
    </g>,
    svgLayer,
  );
}
