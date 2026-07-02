/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dim-with-cutout spotlight for anchored tour steps.
 *
 * One full-viewport SVG whose mask is a white screen rect plus a black
 * rounded rect over the target. The whole layer is pointer-events-none: the
 * dim is guidance, never a modal - the target must stay interactive (tours
 * are task-gated) and z-50 surfaces (menus, palette) render above it.
 * The target rect is tracked per animation frame; floating-ui's autoUpdate
 * does not catch pure layout shift, and the tracked panels re-layout often.
 */

import { useEffect, useState } from 'react';

const PADDING = 6;
const RADIUS = 8;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsDiffer(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a !== b;
  return (
    Math.abs(a.x - b.x) > 0.5
    || Math.abs(a.y - b.y) > 0.5
    || Math.abs(a.width - b.width) > 0.5
    || Math.abs(a.height - b.height) > 0.5
  );
}

export function TourSpotlight({ targetEl }: { targetEl: HTMLElement }) {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    let raf = 0;
    let last: Rect | null = null;
    const track = () => {
      if (!targetEl.isConnected) {
        // Target unmounted mid-step (user closed the panel). Drop the dim
        // rather than spotlighting a stale position; the step stays skippable.
        if (last !== null) {
          last = null;
          setRect(null);
        }
      } else {
        const r = targetEl.getBoundingClientRect();
        const next: Rect = { x: r.x, y: r.y, width: r.width, height: r.height };
        if (rectsDiffer(last, next)) {
          last = next;
          setRect(next);
        }
      }
      raf = requestAnimationFrame(track);
    };
    raf = requestAnimationFrame(track);
    return () => cancelAnimationFrame(raf);
  }, [targetEl]);

  if (!rect) return null;

  const hole = {
    x: rect.x - PADDING,
    y: rect.y - PADDING,
    width: rect.width + PADDING * 2,
    height: rect.height + PADDING * 2,
  };
  // Glide between steps; per-frame tracking updates are small enough that
  // the transition just smooths them.
  const glide = { transition: 'x 150ms ease, y 150ms ease, width 150ms ease, height 150ms ease' };

  return (
    <svg className="fixed inset-0 h-full w-full" aria-hidden="true">
      <defs>
        <mask id="tour-spotlight-mask">
          <rect x="0" y="0" width="100%" height="100%" fill="white" />
          <rect {...hole} rx={RADIUS} fill="black" style={glide} />
        </mask>
      </defs>
      <rect
        x="0"
        y="0"
        width="100%"
        height="100%"
        mask="url(#tour-spotlight-mask)"
        className="fill-black/35 dark:fill-black/50"
      />
      <rect
        {...hole}
        rx={RADIUS}
        fill="none"
        className="stroke-primary/60"
        strokeWidth={1.5}
        style={glide}
      />
    </svg>
  );
}
