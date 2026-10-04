/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { randomBytes } from 'node:crypto';
import { createAuthorizationRequest, parseAuthorizationCallback } from '@ifc-lite/oauth-pkce';
import type { SourceIdentity } from '@ifc-lite/plugin-api';
import { CloudError, endpoints, type CloudConfig, type Vendor } from './config.js';
import { readJson } from './bounded.js';
import { downloadStore } from './download-file.js';
export interface CloudSession {
  id: string; csrf: string; active: boolean; expiresAt: number; lastSeen: number;
  vendor: Vendor; generation: number; identity?: SourceIdentity;
  token?: { access: string; refresh?: string; expires: number };
  refresh?: Promise<string>;
  transaction?: { state: string; verifier: string; expires: number };
  operations: Set<AbortController>;
}
const opaque = () => randomBytes(32).toString('base64url');
export class CloudSessions {
  private readonly entries = new Map<string, CloudSession>();
  private closed = false;
  private operations = 0;
  private readonly pending = new Set<Promise<void>>();
  readonly downloads;
  readonly now: () => number;
  readonly fetcher: typeof fetch;
  constructor(readonly config: CloudConfig) { this.now = config.now ?? Date.now; this.fetcher = config.fetch ?? fetch; this.downloads = downloadStore(config.downloadDirectory); }
  cookie(vendor: Vendor, session?: CloudSession): string {
    return `${this.config.insecureLocalhost ? '' : '__Host-'}ifclite-cloud-${vendor}=${session?.id ?? ''}; Path=/; HttpOnly; SameSite=Lax; ${this.config.insecureLocalhost ? '' : 'Secure; '}Max-Age=${session ? 28800 : 0}`;
  }
  get(request: Request, vendor: Vendor): CloudSession | undefined {
    for (const entry of this.entries.values()) if (entry.expiresAt <= this.now() || entry.lastSeen + 30 * 60_000 <= this.now()) this.discard(entry);
    const name = `${this.config.insecureLocalhost ? '' : '__Host-'}ifclite-cloud-${vendor}=`;
    const id = request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(name))?.slice(name.length);
    const session = id ? this.entries.get(id) : undefined;
    if (!session?.active || session.vendor !== vendor) return undefined;
    session.lastSeen = this.now(); return session;
  }
  create(vendor: Vendor): CloudSession {
    if (this.closed || this.entries.size >= (this.config.maxSessions ?? 1000)) throw new CloudError(503, 'capacity', 'Cloud connections are at capacity.');
    const session: CloudSession = { id: opaque(), csrf: opaque(), vendor, active: true, generation: 0, expiresAt: this.now() + 8 * 3600_000, lastSeen: this.now(), operations: new Set() };
    this.entries.set(session.id, session); return session;
  }
  discard(session: CloudSession): void {
    session.active = false; session.generation++; session.token = undefined; session.transaction = undefined;
    for (const controller of session.operations) controller.abort(); this.entries.delete(session.id);
  }
  async close(timeoutMs = 5000): Promise<void> {
    this.closed = true; for (const session of this.entries.values()) this.discard(session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(() => { console.warn('Cloud cleanup deadline reached'); resolve(); }, timeoutMs); });
    try { await Promise.race([Promise.all([...this.pending]).then(() => undefined), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }
  cancel(session: CloudSession): void { session.generation++; session.transaction = undefined; for (const controller of session.operations) controller.abort(); }
  operation(session: CloudSession, timeout = 30_000, external?: AbortSignal): { signal: AbortSignal; done: () => void } {
    if (!session.active) throw new CloudError(401, 'signed-out', 'Sign in again.');
    if (this.operations >= (this.config.maxOperations ?? 32)) throw new CloudError(503, 'busy', 'Cloud service is busy. Try again.');
    const controller = new AbortController(); session.operations.add(controller); this.operations++; let finished = false;
    let settled: (() => void) | undefined; const pending = new Promise<void>(resolve => { settled = resolve; }); this.pending.add(pending);
    const signals = [controller.signal, AbortSignal.timeout(timeout)]; if (external) signals.push(external);
    return { signal: AbortSignal.any(signals), done: () => { if (!finished) { finished = true; session.operations.delete(controller); this.operations--; this.pending.delete(pending); settled?.(); } } };
  }
  async authorize(session: CloudSession): Promise<{ url: string; state: string }> {
    const app = this.config.apps[session.vendor]; if (!app) throw new CloudError(503, 'unconfigured', 'This cloud source is not configured.');
    this.cancel(session); const generation = session.generation;
    const endpoint = endpoints(session.vendor, app);
    const auth = await createAuthorizationRequest({ authorizationEndpoint: endpoint.authorize, clientId: app.clientId,
      redirectUri: `${this.config.origin}/api/cloud/${session.vendor}/callback`, scope: endpoint.scope,
      extraParams: session.vendor === 'msgraph' ? { prompt: 'select_account' } : undefined });
    if (!session.active || generation !== session.generation) throw new CloudError(401, 'cancelled', 'Sign-in cancelled.');
    session.transaction = { state: auth.state, verifier: auth.codeVerifier, expires: this.now() + 5 * 60_000 };
    return { url: auth.url, state: auth.state };
  }
  private async grant(session: CloudSession, fields: Record<string, string>): Promise<NonNullable<CloudSession['token']>> {
    const app = this.config.apps[session.vendor]; if (!app) throw new CloudError(503, 'unconfigured', 'This cloud source is not configured.');
    const op = this.operation(session);
    try {
      const response = await this.fetcher(endpoints(session.vendor, app).token, { method: 'POST', redirect: 'error', signal: op.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields, client_id: app.clientId, client_secret: app.clientSecret }) });
      if (!response.ok) { await response.body?.cancel(); throw new CloudError(401, 'authorization-expired', 'Cloud authorization expired. Sign in again.'); }
      const value = await readJson(response, 64 * 1024);
      if (!value || typeof value !== 'object') throw new CloudError(502, 'invalid-token', 'Invalid cloud authorization response.');
      const raw = value as Record<string, unknown>;
      if (typeof raw.access_token !== 'string' || !raw.access_token || typeof raw.expires_in !== 'number' || !Number.isFinite(raw.expires_in) || raw.expires_in <= 0) throw new CloudError(502, 'invalid-token', 'Invalid cloud authorization response.');
      return { access: raw.access_token, expires: this.now() + raw.expires_in * 1000, refresh: session.vendor === 'msgraph' && typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined };
    } finally { op.done(); }
  }
  async access(session: CloudSession): Promise<string> {
    if (!session.active || !session.token) throw new CloudError(401, 'signed-out', 'Sign in again.');
    if (session.token.expires > this.now() + 30_000) return session.token.access;
    if (!session.token.refresh) { this.discard(session); throw new CloudError(401, 'authorization-expired', 'Cloud authorization expired. Sign in again.'); }
    if (session.refresh) return session.refresh;
    const refresh = session.token.refresh; const generation = session.generation;
    session.refresh = (async () => {
      try {
        const next = await this.grant(session, { grant_type: 'refresh_token', refresh_token: refresh });
        if (!session.active || generation !== session.generation) throw new CloudError(401, 'signed-out', 'Sign in again.');
        session.token = { ...next, refresh: next.refresh ?? refresh }; return next.access;
      } catch (error) { if (error instanceof CloudError && error.status === 401) this.discard(session); throw error; }
      finally { session.refresh = undefined; }
    })(); return session.refresh;
  }
  async callback(request: Request, session: CloudSession): Promise<CloudSession> {
    const transaction = session.transaction; const generation = session.generation; session.transaction = undefined;
    if (!transaction || transaction.expires <= this.now()) throw new CloudError(400, 'expired-transaction', 'Sign-in expired.');
    const callback = parseAuthorizationCallback(request.url, { expectedRedirectOrigin: this.config.origin, expectedState: transaction.state });
    const token = await this.grant(session, { grant_type: 'authorization_code', code: callback.code, code_verifier: transaction.verifier, redirect_uri: `${this.config.origin}/api/cloud/${session.vendor}/callback` });
    const op = this.operation(session);
    let identity: SourceIdentity;
    try {
      const response = await this.fetcher(session.vendor === 'dropbox' ? 'https://api.dropboxapi.com/2/users/get_current_account' : 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
        method: session.vendor === 'dropbox' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token.access}`, 'Content-Type': 'application/json' },
        body: session.vendor === 'dropbox' ? 'null' : undefined, redirect: 'error', signal: op.signal });
      if (!response.ok) { await response.body?.cancel(); throw new CloudError(502, 'identity-failed', 'Cloud account could not be loaded.'); }
      const raw = await readJson(response, 64 * 1024);
      if (!raw || typeof raw !== 'object') throw new CloudError(502, 'identity-failed', 'Cloud account could not be loaded.');
      const value = raw as Record<string, unknown>; const id = session.vendor === 'dropbox' ? value.account_id : value.id;
      if (typeof id !== 'string') throw new CloudError(502, 'identity-failed', 'Cloud account returned no identity.');
      const name = value.name && typeof value.name === 'object' ? (value.name as Record<string, unknown>).display_name : value.displayName;
      const email = value.email ?? value.mail ?? value.userPrincipalName;
      identity = { id, displayName: typeof name === 'string' ? name : undefined, email: typeof email === 'string' ? email : undefined };
    } finally { op.done(); }
    if (!session.active || generation !== session.generation) throw new CloudError(401, 'cancelled', 'Sign-in cancelled.');
    this.discard(session); const signedIn = this.create(session.vendor); signedIn.token = token; signedIn.identity = identity; return signedIn;
  }
}
