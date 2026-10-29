/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export class RegistryError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

export interface RegistryAccess { repository: string; actions: string[] }
export interface RegistrySession {
  subject: string;
  repositories: RegistryAccess[];
  repository: string;
  actions: string[];
  expiresAt: number;
}

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
export function registryTokenSession(reply: unknown, repository: string | null): { token: string; session: RegistrySession } {
  if (!reply || typeof reply !== 'object' || !('access_token' in reply) || typeof reply.access_token !== 'string' || !reply.access_token.trim() ||
    ('token' in reply && reply.token !== reply.access_token) || !('token_type' in reply) || reply.token_type !== 'Bearer' ||
    !('subject' in reply) || typeof reply.subject !== 'string' || !reply.subject.trim() ||
    !('expires_in' in reply) || typeof reply.expires_in !== 'number' || !Number.isSafeInteger(reply.expires_in) || reply.expires_in <= 0 || reply.expires_in > 900 ||
    !('access' in reply) || !Array.isArray(reply.access)) throw new RegistryError('Invalid registry sign-in response.');
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
  const selected = repository ? repositories.find(access => access.repository === repository) : repositories.find(access => access.actions.includes('pull'));
  if (repository && !selected?.actions.includes('pull')) throw new RegistryError('This account cannot open that model.', 403);
  if (!repository && !catalog) throw new RegistryError('Model browsing is not available at this registry.');
  return { token: reply.access_token, session: { subject: reply.subject, repositories, repository: selected?.repository ?? '', actions: selected?.actions ?? [], expiresAt: Date.now() + reply.expires_in * 1000 } };
}
