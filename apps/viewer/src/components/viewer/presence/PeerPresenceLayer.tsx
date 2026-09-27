/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live peer cursors (collab presence) on the shared scene-overlay kernel
 * (#5511, charter #5478).
 *
 * Each peer's world-space cursor (`cursor3d`, broadcast over Yjs awareness)
 * is registered as a `Pin` on the shared `SceneProjector` — the one rAF loop
 * every scene overlay now shares — instead of the bespoke
 * `requestAnimationFrame` + `projectToScreen` poll this layer used to run
 * itself. IMPORTANT: this is a main-bundle component, so it must NOT import
 * the `@ifc-lite/collab` runtime (yjs/automerge) — it reads only the plain
 * `collabPeers` presence data the store already holds, and derives
 * color/label/opacity inline.
 *
 * A peer's identity colour is data, not a theme token (roadmap §3: "data
 * palettes stay data"), so the cursor `Pin` uses `fill` to override the
 * shared ink/accent classes, and the name pill's background is set inline —
 * same as the pre-kernel version.
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { Pin, AnchoredCard } from '@/components/viewport-ui/scene';
import type { PresenceState } from '@ifc-lite/collab';

/** `collabPeers` entries carry the awareness clientId (attached in collabSlice). */
type PeerPresence = PresenceState & { clientId: number };

/** Fade peers toward transparent as their last update ages (matches presence stale window). */
const IDLE_FADE_START_MS = 4_000;
const STALE_MS = 10_000;

/** A plain function, not a component — it cannot call `useTranslation()` —
 *  so it resolves directly against the locale registry, the same
 *  `t: typeof resolve = resolve` shape `bulk-property-value.ts` uses. */
function peerLabel(peer: PresenceState, t: typeof resolve = resolve): string {
  const name = peer.user?.name ?? t('peerPresenceLayer.guestName');
  // Surface the peer's active tool ("Anna — measuring") like the demo overlay.
  return peer.tool && peer.tool !== 'select' ? t('peerPresenceLayer.nameWithTool', { name, tool: peer.tool }) : name;
}

function peerOpacity(peer: PresenceState, now: number): number {
  const age = now - (peer.lastUpdate ?? now);
  if (age <= IDLE_FADE_START_MS) return 1;
  if (age >= STALE_MS) return 0.35;
  return 1 - (0.65 * (age - IDLE_FADE_START_MS)) / (STALE_MS - IDLE_FADE_START_MS);
}

export function PeerPresenceLayer() {
  const { t } = useTranslation();
  const peers = useViewerStore((s) => s.collabPeers) as unknown as PeerPresence[];
  const sessionActive = useViewerStore((s) => s.collabSession !== null);

  // Only peers carrying a world cursor are drawable.
  const drawablePeers = useMemo(
    () => peers.filter((p) => p.cursor3d && typeof p.clientId === 'number'),
    [peers],
  );

  if (!sessionActive || drawablePeers.length === 0) return null;

  const now = Date.now();

  return (
    <div aria-label={t('peerPresenceLayer.cursorsAriaLabel')}>
      {drawablePeers.map((peer) => {
        const color = peer.user?.color ?? '#5b8def';
        const opacity = peerOpacity(peer, now);
        const label = peerLabel(peer, t);
        return (
          <div key={peer.clientId}>
            <Pin
              worldPoint={peer.cursor3d ?? null}
              fill={color}
              groupProps={{ style: { opacity }, 'data-peer-cursor-id': String(peer.clientId) }}
            />
            <AnchoredCard worldPoint={peer.cursor3d ?? null} offset={{ dx: 12, dy: -28 }}>
              <span
                style={{
                  display: 'inline-block',
                  background: color,
                  color: '#ffffff',
                  font: '600 11px/1.4 system-ui, sans-serif',
                  padding: '1px 6px',
                  borderRadius: 4,
                  whiteSpace: 'nowrap',
                  opacity,
                }}
              >
                {label}
              </span>
            </AnchoredCard>
          </div>
        );
      })}
    </div>
  );
}
