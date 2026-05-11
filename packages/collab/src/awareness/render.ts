/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Presence-renderer math helpers (spec §7).
 *
 * The actual viewer rendering lives in `packages/viewer` (Three.js,
 * WebGPU, …) — but the math that decides "where does this peer's
 * cursor draw, what color, what label, is it stale" is the same
 * regardless of the rendering engine. Pulling it out here keeps the
 * viewer thin and gives every rendering target the same look.
 *
 * Apps consume:
 *   - `peerVisuals(peers, opts)` → list of `{ clientId, color,
 *     label, opacity, cursor3d, cursor2d, selection, isStale }`.
 *   - `cursorScreenPosition(peer, viewport)` → `{ x, y } | null` for
 *     2D cursor projection (3D peers project externally).
 */

import type { PresenceMap, PresenceState } from './presence.js';
import { colorForUser, DEFAULT_USER_PALETTE } from './color.js';
import { AGENT_PALETTE } from './agent.js';

export interface PeerVisual {
  clientId: number;
  user: PresenceState['user'];
  /** Resolved hex color — palette pick if user.color was absent. */
  color: string;
  /** "Anna (agent)", "Mark — measuring", "Louis"… */
  label: string;
  /** 0..1; 1 for fresh, fades to ~0.4 as the peer goes idle / stale. */
  opacity: number;
  /** True when no update has arrived for `staleAfterMs`. */
  isStale: boolean;
  cursor3d?: PresenceState['cursor3d'];
  cursor2d?: PresenceState['cursor2d'];
  selection: string[];
  modelId?: string;
}

export interface PeerVisualOptions {
  /** Drop the local peer from the result. Default true. */
  excludeClientId?: number;
  /** Wall-clock ms after which a peer is considered stale. Default 10_000. */
  staleAfterMs?: number;
  /** Override the random color palette. */
  palette?: readonly string[];
  /** Override the agent palette. */
  agentPalette?: readonly string[];
  /** Override `Date.now`. */
  now?: () => number;
}

/**
 * Convert a `PresenceMap` into render-ready visuals. Pure function —
 * the renderer just iterates the result and draws.
 */
export function peerVisuals(peers: PresenceMap, opts: PeerVisualOptions = {}): PeerVisual[] {
  const exclude = opts.excludeClientId;
  const staleAfterMs = opts.staleAfterMs ?? 10_000;
  const now = opts.now ? opts.now() : Date.now();
  const palette = opts.palette ?? DEFAULT_USER_PALETTE;
  const agentPalette = opts.agentPalette ?? AGENT_PALETTE;

  const out: PeerVisual[] = [];
  for (const [idStr, state] of Object.entries(peers)) {
    const clientId = Number(idStr);
    if (clientId === exclude) continue;
    if (!state || !state.user) continue;
    const isAgent =
      typeof state.user.name === 'string' && state.user.name.endsWith('(agent)');
    const color = state.user.color ?? colorForUser(state.user.id, isAgent ? agentPalette : palette);
    const idleMs = state.lastUpdate ? now - state.lastUpdate : 0;
    const isStale = idleMs >= staleAfterMs;
    const fadeStart = staleAfterMs / 2;
    const opacity = isStale
      ? 0.4
      : idleMs <= fadeStart
        ? 1
        : 1 - (0.6 * (idleMs - fadeStart)) / fadeStart;
    const label = renderLabel(state);
    out.push({
      clientId,
      user: state.user,
      color,
      label,
      opacity: Math.max(0.4, Math.min(1, opacity)),
      isStale,
      cursor3d: state.cursor3d,
      cursor2d: state.cursor2d,
      selection: state.selection ?? [],
      modelId: state.modelId,
    });
  }
  return out.sort((a, b) => a.clientId - b.clientId);
}

function renderLabel(state: PresenceState): string {
  const base = state.user.name;
  if (state.tool && state.tool !== 'select') return `${base} — ${state.tool}`;
  return base;
}

/**
 * Project a peer's `cursor2d` into a viewport. Returns null when the
 * peer is in a different viewport or has no 2D cursor reported.
 */
export function cursorScreenPosition(
  peer: PeerVisual,
  viewportName: string,
): { x: number; y: number } | null {
  if (!peer.cursor2d) return null;
  if (peer.cursor2d.viewport !== viewportName) return null;
  return { x: peer.cursor2d.pos.x, y: peer.cursor2d.pos.y };
}
