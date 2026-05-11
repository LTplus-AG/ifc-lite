/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer bridge (spec §7 + §16.4 — viewer-side rendering).
 *
 * Drop-in glue between a `CollabSession` and `packages/viewer`'s
 * 2D-canvas-overlay-friendly DOM. Apps call this once at viewer
 * mount time and presence rendering is wired end to end:
 *
 *     import { mountPresenceInViewer } from '@ifc-lite/collab';
 *     const teardown = mountPresenceInViewer({
 *       session,
 *       container: document.getElementById('viewer'),
 *       viewport: 'plan',
 *     });
 *     // …on dispose:
 *     teardown();
 *
 * Behind the scenes:
 *   - Mounts a `createPresenceOverlay` over `container`.
 *   - Subscribes to `session.presence.onUpdate` and forwards to the
 *     overlay.
 *   - Wires the local cursor: every mousemove on `container` is
 *     turned into a `setCursor2d` update.
 *   - Cleans everything up on teardown.
 */

import { createPresenceOverlay, type PresenceOverlay } from './awareness/overlay.js';
import type { PresenceMap, Vec3 } from './awareness/presence.js';
import type { CollabSession } from './session.js';

export interface MountPresenceInViewerOptions {
  session: CollabSession;
  container: HTMLElement;
  viewport: string;
  /** Opt out of forwarding mousemove → setCursor* (default: forward). */
  trackLocalCursor?: boolean;
  /**
   * Host-supplied screen→world raycast. When provided, every mousemove
   * is converted to a 3D world-space point via this callback and
   * broadcast as `cursor3d`. Each peer then reprojects it through
   * THEIR camera, so cursors stay anchored to the same point in the
   * model regardless of camera perspective.
   *
   * When omitted, the bridge falls back to publishing `cursor2d` only
   * (the legacy fixed-projection behaviour — accurate only when every
   * peer shares the same view, e.g. orthographic plan layouts).
   *
   * Return `null` on a ray miss; the bridge will keep the previously
   * published cursor rather than spamming clears.
   */
  raycastToWorld?: (screenX: number, screenY: number) => Vec3 | null;
}

export type Teardown = () => void;

export function mountPresenceInViewer(opts: MountPresenceInViewerOptions): Teardown {
  if (typeof document === 'undefined') {
    throw new Error('@ifc-lite/collab: mountPresenceInViewer requires a browser DOM');
  }

  const overlay: PresenceOverlay = createPresenceOverlay({
    container: opts.container,
    viewport: opts.viewport,
    excludeClientId: opts.session.clientId,
  });

  const presenceUnsub = opts.session.presence.onUpdate((peers: PresenceMap) => {
    overlay.update(peers);
  });

  const handleMove = (event: MouseEvent) => {
    const rect = opts.container.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    if (opts.raycastToWorld) {
      const hit = opts.raycastToWorld(localX, localY);
      // On a miss we deliberately leave the last cursor3d in place —
      // see the option doc comment above.
      if (hit) {
        opts.session.presence.setCursor3d(hit);
      }
      return;
    }
    opts.session.presence.setCursor2d(opts.viewport, { x: localX, y: localY });
  };

  const clearLocalCursor = () => {
    if (opts.raycastToWorld) {
      opts.session.presence.setCursor3d(null);
    } else {
      opts.session.presence.setCursor2d(opts.viewport, null);
    }
  };

  if (opts.trackLocalCursor !== false) {
    opts.container.addEventListener('mousemove', handleMove);
    opts.container.addEventListener('mouseleave', clearLocalCursor);
  }

  return () => {
    presenceUnsub();
    if (opts.trackLocalCursor !== false) {
      opts.container.removeEventListener('mousemove', handleMove);
      opts.container.removeEventListener('mouseleave', clearLocalCursor);
      // Explicitly clear our published cursor — unmounting without
      // a prior `mouseleave` (e.g. SPA route change while pointer is
      // inside the viewport) used to leave stale cursors visible to
      // other peers until the session disposed.
      clearLocalCursor();
    }
    overlay.destroy();
  };
}
