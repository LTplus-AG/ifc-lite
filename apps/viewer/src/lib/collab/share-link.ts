/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Share-link construction (M1 scaffolding, plan §4.6 — seed-into-room).
 *
 * The chosen transport puts no model URL in the link: the recipient hydrates
 * the model from the Y.Doc on join. The link therefore only needs the room id
 * and a signed room token:
 *
 *   https://<viewer-origin>/?room=<roomId>&t=<token>
 *
 * Minting the token is a collab-server responsibility (plan §3.1, §7.7). Until
 * that route exists, `mintRoomToken` returns a clearly-marked dev placeholder
 * so the UI flow is exercisable end to end in local-only mode.
 */

import type { CollabRole } from '@/store/slices/collabSlice';

/** Generate an opaque, owner-minted room id (plan §4.1). */
export function mintRoomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    // Short, URL-friendly slice of a UUID — collision-safe for room scale.
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}

export interface RoomTokenRequest {
  roomId: string;
  role: CollabRole;
  /** Time-to-live in seconds (default 7 days). */
  ttlSeconds?: number;
}

/**
 * Request a signed room token from the collab-server token route.
 *
 * TODO(plan §7.7): POST to `${collabServerHttpUrl}/collab/token` with the
 * owner token and have the server sign a JWT carrying { room, role, exp }.
 * For now this returns a non-cryptographic placeholder so the Share dialog
 * renders a complete link in local-only/dev mode.
 */
export async function mintRoomToken(req: RoomTokenRequest): Promise<string> {
  const ttl = req.ttlSeconds ?? 7 * 24 * 60 * 60;
  const placeholder = {
    dev: true,
    room: req.roomId,
    role: req.role,
    exp: Math.floor(Date.now() / 1000) + ttl,
  };
  // base64url of the JSON — NOT a real signed token. Replaced by the server.
  const json = JSON.stringify(placeholder);
  const b64 =
    typeof btoa !== 'undefined'
      ? btoa(json)
      : Buffer.from(json, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Best-effort read of the role from a room token, for UI gating only.
 *
 * The authoritative role check happens on the collab-server via the signed
 * token (plan §3); the client value just decides which affordances to show.
 * Works against the dev placeholder today; a real JWT decodes the same
 * base64url payload (signature verification stays server-side).
 */
export function parseRoleFromToken(token: string): CollabRole | null {
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const json =
      typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('utf8');
    const payload: unknown = JSON.parse(json);
    if (typeof payload === 'object' && payload !== null) {
      const role = (payload as Record<string, unknown>).role;
      if (role === 'viewer' || role === 'commenter' || role === 'editor' || role === 'admin') {
        return role;
      }
    }
  } catch {
    // not a decodable payload (e.g. opaque server token) — caller defaults
  }
  return null;
}

/** Build the full shareable URL for a room + token. */
export function buildShareUrl(roomId: string, token: string): string {
  const origin =
    typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '';
  const params = new URLSearchParams({ room: roomId, t: token });
  return `${origin}?${params.toString()}`;
}
