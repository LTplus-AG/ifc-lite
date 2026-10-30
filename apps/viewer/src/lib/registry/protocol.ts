/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseGrants, grantAllows, type RegistryGrant } from './grants';

export class RegistryError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

export interface RegistryAccess { repository: string; actions: string[] }
export interface RegistrySession {
  permissions?: RegistryGrant[];
  publicationHeaders?: { publisher: string; pushedAt: string };
  authorizationType?: 'session' | 'share' | 'access';
  subject: string;
  repositories: RegistryAccess[];
  repository: string;
  actions: string[];
  expiresAt: number;
  sessionExpiresAt: number;
  remembered: boolean;
}

export interface RegistryAuthorization { token: string; session: RegistrySession; clientId: string; refreshToken?: string; shareSecret?: string }
export const REGISTRY_REFRESH_COOKIE = 'oci_registry_refresh';

export function repositoryName(value: string): string {
  if (value.length > 255 || !/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(value)) {
    throw new RegistryError('Enter a repository such as project/model.');
  }
  return value;
}

export function releaseName(value: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new RegistryError('Use letters, numbers, dots, underscores or hyphens for the version.');
  }
  return value;
}

export async function responseBytes(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) throw new RegistryError('The registry returned an empty response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new RegistryError('The registry response exceeds the supported size.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Registry OAuth extends the standard token response with identity and exact grants. */
export function registryTokenSession(reply: unknown, repository: string | null, clientId: string): RegistryAuthorization {
  const share = Boolean(reply && typeof reply === 'object' && 'authorization_type' in reply && reply.authorization_type === 'share');
  if (!reply || typeof reply !== 'object' || !('access_token' in reply) || typeof reply.access_token !== 'string' || !reply.access_token.trim() ||
    ('token' in reply && reply.token !== reply.access_token) || !('token_type' in reply) || reply.token_type !== 'Bearer' ||
    !('subject' in reply) || typeof reply.subject !== 'string' || !reply.subject.trim() ||
    !('expires_in' in reply) || typeof reply.expires_in !== 'number' || !Number.isSafeInteger(reply.expires_in) || reply.expires_in <= 0 || reply.expires_in > 900 ||
    !('remember_me' in reply) || typeof reply.remember_me !== 'boolean' ||
    !('session_expires_in' in reply) || typeof reply.session_expires_in !== 'number' || !Number.isSafeInteger(reply.session_expires_in) || reply.session_expires_in <= 0 ||
    (!share && reply.session_expires_in > (reply.remember_me ? 30 * 24 * 3600 : 8 * 3600)) ||
    !('session_expires_at' in reply) || typeof reply.session_expires_at !== 'number' || !Number.isSafeInteger(reply.session_expires_at) || reply.session_expires_at <= 0 ||
    (share ? reply.remember_me || 'refresh_token' in reply : reply.remember_me ? 'refresh_token' in reply : !('refresh_token' in reply) || typeof reply.refresh_token !== 'string' || !reply.refresh_token.trim() || reply.refresh_token.length > 4096) ||
    !('access' in reply) || !Array.isArray(reply.access)) throw new RegistryError('Invalid registry sign-in response.');
  const authorizationType = 'authorization_type' in reply ? reply.authorization_type : 'access';
  if (authorizationType !== 'session' && authorizationType !== 'share' && authorizationType !== 'access') throw new RegistryError('Invalid authorization type.');
  const permissions = authorizationType !== 'access' ? parseGrants('permissions' in reply ? reply.permissions : undefined) : undefined;
  const repositories: RegistryAccess[] = [];
  let catalog = false;
  for (const access of reply.access as unknown[]) {
    if (!access || typeof access !== 'object' || !('name' in access) || typeof access.name !== 'string' ||
      !('type' in access) || !('actions' in access) || !Array.isArray(access.actions)) throw new RegistryError('Invalid registry access grants.');
    if (access.type === 'registry' && access.name === 'catalog' && access.actions.includes('read')) catalog = true;
    if (access.type === 'repository') {
      repositories.push({ repository: repositoryName(access.name), actions: access.actions.filter((action: unknown): action is string => action === 'pull' || action === 'push') });
    }
  }
  if (permissions && repositories.length) throw new RegistryError('A session credential must not contain repository access.');
  const selected = repository ? repositories.find(access => access.repository === repository) : repositories.find(access => access.actions.includes('pull'));
  if (repository && !(permissions ? grantAllows(permissions, repository, 'pull') : selected?.actions.includes('pull'))) throw new RegistryError('This account cannot open that model.', 403);
  if (!repository && !catalog) throw new RegistryError('Model browsing is not available at this registry.');
  let publicationHeaders: RegistrySession['publicationHeaders'];
  if ('publication_headers' in reply) {
    const headers = reply.publication_headers;
    const validName = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(name);
    if (!headers || typeof headers !== 'object' || !('publisher' in headers) || !validName(headers.publisher) ||
      !('pushed_at' in headers) || !validName(headers.pushed_at)) throw new RegistryError('Invalid publication header metadata.');
    publicationHeaders = { publisher: headers.publisher, pushedAt: headers.pushed_at };
  }
  const now = Date.now();
  const sessionExpiresAt = Math.min(reply.session_expires_at * 1000, now + reply.session_expires_in * 1000);
  if (sessionExpiresAt <= now) throw new RegistryError('Your registry session has expired. Please sign in again.', 401);
  const approvedRepository = permissions ? repository ?? permissions.flatMap(g => g.repositories).find(r => !r.includes('*')) ?? '' : selected?.repository ?? '';
  const actions = permissions ? (['pull', 'push'] as const).filter(a => grantAllows(permissions, approvedRepository, a)) : selected?.actions ?? [];
  return { token: reply.access_token, clientId, refreshToken: 'refresh_token' in reply && typeof reply.refresh_token === 'string' ? reply.refresh_token : undefined,
    session: { subject: reply.subject, permissions, authorizationType, publicationHeaders, repositories, repository: approvedRepository, actions,
      expiresAt: Math.min(sessionExpiresAt, now + reply.expires_in * 1000), sessionExpiresAt, remembered: reply.remember_me } };
}
