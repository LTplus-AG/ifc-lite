/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DOM-billboard overlay for live peer cursors (collab presence).
 *
 * Each peer broadcasts a world-space cursor point (`cursor3d`) over Yjs
 * awareness; this layer re-projects every peer's point to screen space each
 * frame via the same camera callbacks the annotation layer uses, so a peer's
 * cursor sticks to the model point regardless of *your* camera angle.
 *
 * Mirrors AnnotationLayer's rAF-projection pattern. IMPORTANT: this is a
 * main-bundle component, so it must NOT import the `@ifc-lite/collab` runtime
 * (yjs/automerge) — it reads only the plain `collabPeers` presence data the
 * store already holds, and derives color/label/opacity inline.
 */

import { useEffect, useMemo, useState } from 'react';
import { useViewerStore } from '@/store';
import type { PresenceState } from '@ifc-lite/collab';

/** `collabPeers` entries carry the awareness clientId (attached in collabSlice). */
type PeerPresence = PresenceState & { clientId: number };

/** Fade peers toward transparent as their last update ages (matches presence stale window). */
const IDLE_FADE_START_MS = 4_000;
const STALE_MS = 10_000;

interface ProjectedCursor {
  clientId: number;
  screen: { x: number; y: number };
  color: string;
  label: string;
  opacity: number;
}

function peerLabel(peer: PresenceState): string {
  const name = peer.user?.name ?? 'Guest';
  // Surface the peer's active tool ("Anna — measuring") like the demo overlay.
  return peer.tool && peer.tool !== 'select' ? `${name} — ${peer.tool}` : name;
}

function peerOpacity(peer: PresenceState, now: number): number {
  const age = now - (peer.lastUpdate ?? now);
  if (age <= IDLE_FADE_START_MS) return 1;
  if (age >= STALE_MS) return 0.35;
  return 1 - (0.65 * (age - IDLE_FADE_START_MS)) / (STALE_MS - IDLE_FADE_START_MS);
}

export function PeerPresenceLayer() {
  const peers = useViewerStore((s) => s.collabPeers) as unknown as PeerPresence[];
  const sessionActive = useViewerStore((s) => s.collabSession !== null);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);

  const [cursors, setCursors] = useState<ProjectedCursor[]>([]);

  // Only peers carrying a world cursor are drawable. Captured per-render; the
  // rAF tick below reads this closure.
  const drawablePeers = useMemo(
    () => peers.filter((p) => p.cursor3d && typeof p.clientId === 'number'),
    [peers],
  );

  useEffect(() => {
    const project = cameraCallbacks.projectToScreen;
    if (!sessionActive || !project || drawablePeers.length === 0) {
      setCursors([]);
      return;
    }

    let raf: number | null = null;
    let lastSerialized = '';

    const tick = () => {
      const now = Date.now();
      const next: ProjectedCursor[] = [];
      for (const peer of drawablePeers) {
        const screen = peer.cursor3d ? project(peer.cursor3d) : null;
        if (!screen) continue;
        next.push({
          clientId: peer.clientId,
          screen,
          color: peer.user?.color ?? '#5b8def',
          label: peerLabel(peer),
          opacity: peerOpacity(peer, now),
        });
      }
      const serialized = next
        .map((c) => `${c.clientId}:${c.screen.x | 0}:${c.screen.y | 0}:${c.opacity.toFixed(2)}`)
        .join(',');
      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        setCursors(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [cameraCallbacks, drawablePeers, sessionActive]);

  if (cursors.length === 0) return null;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-label="Collaborator cursors">
      {cursors.map((c) => (
        <div
          key={c.clientId}
          className="absolute"
          style={{ left: c.screen.x, top: c.screen.y, opacity: c.opacity, transition: 'opacity 200ms linear' }}
        >
          {/* Cursor arrow (peer color, white outline for contrast). */}
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            style={{ display: 'block', filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.4))' }}
            aria-hidden="true"
          >
            <path d="M2 2 L2 14 L6 10 L9 16 L11 15 L8 9 L14 9 Z" fill={c.color} stroke="#ffffff" strokeWidth="1.2" />
          </svg>
          {/* Name / tool pill. */}
          <span
            style={{
              position: 'absolute',
              left: 16,
              top: 10,
              background: c.color,
              color: '#ffffff',
              font: '600 11px/1.4 system-ui, sans-serif',
              padding: '1px 6px',
              borderRadius: 4,
              whiteSpace: 'nowrap',
              boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
            }}
          >
            {c.label}
          </span>
        </div>
      ))}
    </div>
  );
}
