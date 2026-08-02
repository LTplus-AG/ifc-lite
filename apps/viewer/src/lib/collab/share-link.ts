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
import { collabServerUrl } from '@/lib/collab/config';

/** ws(s):// → http(s):// base for the collab-server HTTP routes. */
function collabHttpBase(serverUrl: string): string {
  return serverUrl.replace(/^ws/, 'http').replace(/\/$/, '');
}

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
  /**
   * Admin bearer token. Required to mint a role-scoped link once a room exists;
   * omit on the very first (room-creation) mint, where the server grants the
   * creator admin (first-touch). Ignored in local-only/dev mode.
   */
  bearer?: string;
}

/**
 * Mint a signed room token. With a collab-server configured this POSTs to its
 * `/collab/token` route, which signs a JWT carrying { room, role, exp } (and
 * enforces the mint policy — see the server's `tokenEndpoint.authorize`). In
 * local-only/dev mode (no server) it falls back to a clearly-marked
 * non-cryptographic placeholder so the Share flow still works offline.
 */
export async function mintRoomToken(req: RoomTokenRequest): Promise<string> {
  const serverUrl = collabServerUrl();
  if (serverUrl) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (req.bearer) headers['authorization'] = `Bearer ${req.bearer}`;
    const res = await fetch(`${collabHttpBase(serverUrl)}/collab/token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ roomId: req.roomId, role: req.role, ttlSeconds: req.ttlSeconds }),
    });
    if (!res.ok) throw new Error(`@ifc-lite: token mint failed (${res.status})`);
    const json = (await res.json()) as { token?: string };
    if (!json.token) throw new Error('@ifc-lite: token mint returned no token');
    return json.token;
  }

  const ttl = req.ttlSeconds ?? 7 * 24 * 60 * 60;
  const placeholder = {
    dev: true,
    room: req.roomId,
    role: req.role,
    exp: Math.floor(Date.now() / 1000) + ttl,
  };
  // base64url of the JSON — NOT a real signed token. Dev/local-only fallback.
  const json = JSON.stringify(placeholder);
  const b64 =
    typeof btoa !== 'undefined'
      ? btoa(json)
      : Buffer.from(json, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Revoke a previously-minted share link via the collab-server. Requires an
 * admin bearer token for the same room. No-op (returns false) in local-only
 * mode. The server adds the link's `jti` to its deny-list so future joins with
 * it are rejected.
 */
export async function revokeRoomToken(shareToken: string, adminBearer: string): Promise<boolean> {
  const serverUrl = collabServerUrl();
  if (!serverUrl) return false;
  const res = await fetch(`${collabHttpBase(serverUrl)}/collab/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminBearer}` },
    body: JSON.stringify({ token: shareToken }),
  });
  return res.ok;
}

/**
 * Admin: force-disconnect a peer by its awareness clientId. Requires an admin
 * bearer token for the room. No-op (false) in local-only mode.
 */
export async function kickRoomPeer(
  roomId: string,
  clientId: number,
  adminBearer: string,
): Promise<boolean> {
  const serverUrl = collabServerUrl();
  if (!serverUrl) return false;
  const res = await fetch(`${collabHttpBase(serverUrl)}/collab/kick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminBearer}` },
    body: JSON.stringify({ roomId, clientId }),
  });
  if (!res.ok) return false;
  const json = (await res.json()) as { kicked?: boolean };
  return json.kicked === true;
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
    // A signed JWT is `header.payload.signature` — decode the middle (payload)
    // segment. The dev placeholder is a single base64url JSON blob, so fall back
    // to the whole token. Re-pad base64url before decoding.
    const parts = token.split('.');
    const segment = parts.length === 3 ? parts[1] : token;
    const b64Raw = segment.replace(/-/g, '+').replace(/_/g, '/');
    const b64 = b64Raw + '='.repeat((4 - (b64Raw.length % 4)) % 4);
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
