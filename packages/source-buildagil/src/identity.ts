/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceIdentity } from '@ifc-lite/plugin-api';

/**
 * The signed-in account, read from the access token's claims. The openCDE
 * API has no current-user endpoint, and buildagil's tokens come from
 * Microsoft Entra ID, whose JWTs carry `oid`, `name` and
 * `preferred_username`. Display only: the claims are decoded, not verified;
 * the API verifies the token on every request. An opaque token still signs
 * in, under a generic identity.
 */
export function identityFromAccessToken(token: string): SourceIdentity {
  const claims = decodeClaims(token);
  const str = (key: string) => (typeof claims[key] === 'string' && claims[key] !== '' ? claims[key] as string : undefined);
  const email = [str('email'), str('preferred_username'), str('upn')].find((value) => value?.includes('@'));
  return {
    id: str('oid') ?? str('sub') ?? email ?? 'buildagil-account',
    displayName: str('name') ?? email,
    email,
  };
}

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    console.debug('[source-buildagil] access token is not a decodable JWT', error instanceof Error ? error.name : error);
    return {};
  }
}
