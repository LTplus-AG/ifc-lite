/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authentication hook contract.
 *
 * The server stays pluggable: implementers wire up JWT verification,
 * cookie-based auth, or whatever else they need by passing an
 * `AuthenticateFn` to `startCollabServer`. Spec §8.2.
 */

export type Role = 'viewer' | 'commenter' | 'editor' | 'admin';

export interface Principal {
  userId: string;
  role: Role;
  /** Optional room-scoped capability — checked again every 5 minutes per spec. */
  expiresAt?: number;
  /** Free-form metadata (e.g. tenant id) the server forwards into audit logs. */
  meta?: Record<string, unknown>;
}

export type AuthenticateFn = (
  token: string | undefined,
  roomId: string,
) => Promise<Principal | null> | Principal | null;

/** Default: anonymous editor, useful for local dev. */
export const allowAnonymousEditor: AuthenticateFn = (_token, _room) => ({
  userId: 'anonymous',
  role: 'editor',
});

/** Default: hard-deny. Apps that don't supply an auth hook get this. */
export const denyAll: AuthenticateFn = () => null;

/** Role → write capability check used by `applyUpdateOrDeny`. */
export function canWrite(principal: Principal): boolean {
  return principal.role === 'editor' || principal.role === 'admin';
}
