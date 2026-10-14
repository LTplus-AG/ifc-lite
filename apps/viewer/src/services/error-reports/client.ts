/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReportSession } from '@ifc-lite/report-contract';

export class ReportRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'ReportRequestError'; }
}
export class ReportClient {
  private csrfToken = '';
  constructor(private readonly transport: typeof fetch = globalThis.fetch.bind(globalThis), private readonly base = '/api/reports') {}
  async session(signal?: AbortSignal): Promise<ReportSession> {
    const session = await this.request<ReportSession>('/session', 'GET', undefined, signal);
    if (!session.csrfToken || !Number.isSafeInteger(session.limits?.partBytes) || session.limits.partBytes <= 0 || !Number.isSafeInteger(session.limits.maxFileBytes) || typeof session.agreement?.text !== 'string' || typeof session.agreement.signingEnabled !== 'boolean' || !session.storage?.provider || !session.storage.location || typeof session.storage.backupDisclosure !== 'string') throw new Error('Invalid reporting configuration');
    this.csrfToken = session.csrfToken;
    return session;
  }
  async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.transport(this.base + path, {
      method, credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'X-CSRF-Token': this.csrfToken } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      let code: string | undefined;
      let message = `Reporting request failed (${response.status})`;
      if (response.headers.get('content-type')?.includes('application/json')) {
        try {
          const body: unknown = await response.json();
          if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(body.error)) code = body.error;
          if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string' && body.message.length > 0 && body.message.length <= 500 && [...body.message].every(character => { const code = character.charCodeAt(0); return code >= 32 || code === 9 || code === 10 || code === 13; })) message = body.message;
        } catch { console.warn('[error-report] Service returned an invalid error response'); }
      }
      throw new ReportRequestError(message, response.status, code);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
  async putPart(url: string, bytes: ArrayBuffer, checksum: string, signal: AbortSignal): Promise<void> {
    const target = new URL(url);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))) throw new Error('Unsafe upload destination');
    const response = await this.transport(url, {
      method: 'PUT', body: bytes, signal, credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { 'x-amz-checksum-sha256': checksum, 'Content-Type': 'application/octet-stream' },
    });
    if (!response.ok) throw new Error(`Model upload failed (${response.status})`);
  }
}

export function safeIssueUrl(value: string | undefined): string | undefined {
  if (!value) return;
  if (!URL.canParse(value)) return;
  const url = new URL(value);
  if (url.origin === 'https://github.com' && /^\/LTplus-AG\/ifc-lite\/issues\/\d+$/.test(url.pathname)) return url.href;
}
export function safeAgreementUrl(value: string | undefined): string | undefined {
  if (!value || !/^\/api\/reports\/[a-zA-Z0-9-]+\/agreement\.pdf$/.test(value)) return;
  return value;
}

/** Only generic same-origin public delivery links may leave the receipt UI. */
export function safePublicModelUrl(value: string | undefined, origin = globalThis.location?.origin): string | undefined {
  if (!value || !origin || !URL.canParse(value, origin)) return;
  const url = new URL(value, origin);
  if (url.origin === origin && !url.username && !url.password && !url.search && !url.hash &&
    /^\/api\/reports\/public\/[a-f0-9]{64}$/.test(url.pathname)) return url.pathname;
}
