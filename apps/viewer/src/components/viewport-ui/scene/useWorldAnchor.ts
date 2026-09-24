/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useWorldAnchor`: registers a world point with the scene projector and
 * writes its screen transform straight onto a DOM/SVG ref every dirty tick
 * — no `setState`, so a moving anchor never re-renders its React tree
 * (#5486). Visibility (behind camera / off-screen) is written the same way:
 * `style.display`, not the `hidden` IDL attribute — `lib.dom.d.ts` only
 * types `.hidden` on `HTMLElement`, not `SVGElement`, even though browsers
 * support it there too (the HTML-in-SVG mixin); `style.display` is typed on
 * both and needs no cast.
 */

import { useEffect, useId, useRef, type RefObject } from 'react';
import { useSceneProjector } from './SceneProjectorProvider';
import type { AnchorProjection, Vec3 } from './types';

type AnchorElement = HTMLElement | SVGElement;

export interface WorldAnchorHandle<T extends AnchorElement> {
  /** Attach to the element that should track `getWorldPoint()` in screen space. */
  ref: RefObject<T | null>;
}

/**
 * `applyTransform` lets each primitive shape choose how a screen point
 * becomes CSS: an SVG `<g>` wants `translate(x px, y px)` (a `transform`
 * attribute is fine at this scale), an absolutely-positioned `<div>` wants
 * `translate(x px, y px)` via `style.transform`, a `<line>` wants x1/y1
 * written directly with no wrapper. Defaults to the `<div>`/`<g>` case.
 */
export function defaultApplyTransform(el: AnchorElement, screen: { x: number; y: number }): void {
  el.style.setProperty('transform', `translate(${screen.x}px, ${screen.y}px)`);
}

export interface UseWorldAnchorOptions<T extends AnchorElement> {
  /** Called every dirty tick with the raw projection, in case a primitive needs more than translate+hide (e.g. an arrow's direction). */
  onProject?: (projection: AnchorProjection, el: T) => void;
  /** Overrides how a resolved screen point is written onto the element. */
  applyTransform?: (el: T, screen: { x: number; y: number }) => void;
}

export function useWorldAnchor<T extends AnchorElement>(
  getWorldPoint: () => Vec3 | null,
  options: UseWorldAnchorOptions<T> = {},
): WorldAnchorHandle<T> {
  const ref = useRef<T | null>(null);
  const projector = useSceneProjector();
  const id = useId();
  // Read the latest getWorldPoint/callbacks without re-registering the anchor
  // on every render (they're near-always fresh closures from the caller).
  const latest = useRef({ getWorldPoint, ...options });
  latest.current = { getWorldPoint, ...options };

  useEffect(() => {
    if (!projector) return;
    const unregister = projector.registerAnchor(
      id,
      () => latest.current.getWorldPoint(),
      (projection) => {
        const el = ref.current;
        if (!el) return;
        if (projection.screen) {
          el.style.display = '';
          (latest.current.applyTransform ?? defaultApplyTransform)(el, projection.screen);
        } else {
          el.style.display = 'none';
        }
        latest.current.onProject?.(projection, el);
      },
    );
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projector, id]);

  return { ref };
}
