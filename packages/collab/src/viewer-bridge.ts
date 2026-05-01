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
import type { PresenceMap } from './awareness/presence.js';
import type { CollabSession } from './session.js';

export interface MountPresenceInViewerOptions {
  session: CollabSession;
  container: HTMLElement;
  viewport: string;
  /** Opt out of forwarding mousemove → setCursor2d (default: forward). */
  trackLocalCursor?: boolean;
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
    opts.session.presence.setCursor2d(opts.viewport, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const handleLeave = () => {
    opts.session.presence.setCursor2d(opts.viewport, null);
  };

  if (opts.trackLocalCursor !== false) {
    opts.container.addEventListener('mousemove', handleMove);
    opts.container.addEventListener('mouseleave', handleLeave);
  }

  return () => {
    presenceUnsub();
    if (opts.trackLocalCursor !== false) {
      opts.container.removeEventListener('mousemove', handleMove);
      opts.container.removeEventListener('mouseleave', handleLeave);
    }
    overlay.destroy();
  };
}
